import { CommandId, ThreadId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  isSnoozeDependencyDone,
  loadSnoozeDependency,
  snoozeWaitingThreadIds,
} from "./snoozeUntilSettled.ts";

/**
 * Wakes a thread snoozed until other threads settle once the last of them is settled, archived,
 * or deleted. The startup sweep covers dependencies that finished while the server was down.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;

    // Snoozes that wait on threads are few, so their rows are read directly.
    const toWaiterIds = (rows: ReadonlyArray<{ readonly thread_id: string }>) =>
      rows.map((row) => ThreadId.make(row.thread_id));
    const listAllWaiterIds = (now: DateTime.Utc) =>
      sql<{ readonly thread_id: string }>`
        SELECT t.thread_id
        FROM orchestration_v2_projection_threads AS t
        WHERE t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND json_array_length(t.payload_json, '$.snoozeUntilSettledThreadIds') > 0
          AND julianday(json_extract(t.payload_json, '$.snoozedUntil'))
            > julianday(${DateTime.formatIso(now)})
      `.pipe(NodeSqliteClient.readOnly, Effect.map(toWaiterIds));
    const listWaiterIdsOf = (dependencyThreadId: ThreadId, now: DateTime.Utc) =>
      sql<{ readonly thread_id: string }>`
        SELECT t.thread_id
        FROM orchestration_v2_projection_threads AS t
        WHERE t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND json_array_length(t.payload_json, '$.snoozeUntilSettledThreadIds') > 0
          AND julianday(json_extract(t.payload_json, '$.snoozedUntil'))
            > julianday(${DateTime.formatIso(now)})
          AND EXISTS (
            SELECT 1 FROM json_each(t.payload_json, '$.snoozeUntilSettledThreadIds') AS dependency
            WHERE dependency.value = ${dependencyThreadId}
          )
      `.pipe(NodeSqliteClient.readOnly, Effect.map(toWaiterIds));

    const wakeIfSettled = Effect.fn("SnoozeUntilSettledWorker.wakeIfSettled")(function* (
      waiterId: ThreadId,
    ) {
      const waiter = yield* projections.getThread(waiterId);
      const now = yield* DateTime.now;
      const waitingThreadIds = snoozeWaitingThreadIds(waiter, DateTime.toEpochMillis(now));
      // The decider refuses to unsnooze an archived thread; unarchiving it evaluates it again.
      if (waitingThreadIds === null || waiter.archivedAt !== null || waiter.deletedAt !== null) {
        return;
      }
      const dependencies = yield* Effect.forEach(waitingThreadIds, (threadId) =>
        loadSnoozeDependency(projections, threadId),
      );
      if (!dependencies.every(isSnoozeDependencyDone)) return;

      // Each attempt is new: the decider re-checks the snooze, so a duplicate wake is refused.
      const uuid = yield* random.uuidV4();
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make(`server:snooze-threads-settled:${waiterId}:${uuid}`),
        threadId: waiterId,
        reason: "threads_settled",
      });
    });

    const wakeEach = (waiterIds: ReadonlyArray<ThreadId>) =>
      Effect.forEach(
        waiterIds,
        (waiterId) =>
          wakeIfSettled(waiterId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.snooze-until-settled.wake-failed", {
                threadId: waiterId,
                cause,
              }),
            ),
          ),
        { discard: true },
      );
    const wakeAllWaiters = Effect.fn("SnoozeUntilSettledWorker.wakeAllWaiters")(function* () {
      yield* wakeEach(yield* listAllWaiterIds(yield* DateTime.now));
    });
    const wakeWaitersOf = Effect.fn("SnoozeUntilSettledWorker.wakeWaitersOf")(function* (
      dependencyThreadId: ThreadId,
    ) {
      yield* wakeEach(yield* listWaiterIdsOf(dependencyThreadId, yield* DateTime.now));
    });

    // Read the sequence before sweeping so no settle between the two is missed.
    const afterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
    const streamOf = (eventTypes: ReadonlyArray<OrchestrationV2DomainEvent["type"]>) =>
      Stream.mergeAll(
        eventTypes.map((eventType) => eventSink.stream({ afterSequence, eventType })),
        { concurrency: "unbounded" },
      );
    // A dependency that finishes wakes its waiters. A new snooze, or an unarchived waiter, is
    // evaluated itself: its dependencies may have finished while it was decided or archived.
    const logFailure = <E>(wake: Effect.Effect<void, E>) =>
      wake.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.snooze-until-settled.wake-failed", { cause }),
        ),
      );
    const changes = Stream.merge(
      streamOf(["thread.settled", "thread.archived", "thread.deleted"]).pipe(
        Stream.map((stored) => logFailure(wakeWaitersOf(stored.event.threadId))),
      ),
      streamOf(["thread.snoozed", "thread.unarchived"]).pipe(
        Stream.map((stored) => logFailure(wakeEach([stored.event.threadId]))),
      ),
    );
    yield* forkParked(
      wakeAllWaiters().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.snooze-until-settled.sweep-failed", { cause }),
        ),
        Effect.andThen(Stream.runForEach(changes, (wake) => wake)),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.snooze-until-settled.stream-failed", { cause }),
        ),
      ),
    );
  }),
);
