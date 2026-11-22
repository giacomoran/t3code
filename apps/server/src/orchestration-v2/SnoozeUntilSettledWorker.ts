import {
  CommandId,
  type EnvironmentId,
  type OrchestratorMcpFailure,
  type OrchestrationV2DomainEvent,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  isSnoozeDependencyDone,
  loadSnoozeDependency,
  snoozeWaitingDependencies,
} from "./snoozeUntilSettled.ts";

/** How often waiters on linked threads read them again: a peer never says when they settle. */
const LINKED_POLL_INTERVAL = Duration.seconds(60);
/** A linked environment whose reads fail is left alone for longer each time, up to this. */
const LINKED_MAX_BACKOFF = Duration.minutes(5);
/** One read of a linked thread; a slower answer counts as not answering. */
const LINKED_READ_TIMEOUT = Duration.seconds(30);
/** Linked reads in flight at once, so slow peers hold only a few. */
const LINKED_READ_CONCURRENCY = 4;

/** A linked thread as one read through the link found it; "unreachable" never wakes. */
type LinkedDependencyState = "done" | "open" | "unreachable";

/**
 * Wakes a thread snoozed until other threads settle once the last of them is settled, archived,
 * or deleted. Threads here are followed through their events; threads in linked environments
 * are read through the link, after local changes and on a poll. The startup sweep covers
 * dependencies that finished while the server was down.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const random = yield* SecureRandom.SecureRandom;
    const forwarding = yield* PeerForwarding.PeerForwarding;
    const peerLinks = yield* PeerLinks.PeerLinks;
    const hereId = yield* ServerEnvironment.ServerEnvironment.pipe(
      Effect.flatMap((environment) => environment.getEnvironmentId),
    );
    const workerScope = yield* Effect.scope;
    const linkedReads = yield* Semaphore.make(LINKED_READ_CONCURRENCY);
    // Linked environments whose last read failed, and when to read them again.
    const backoffByEnvironment = new Map<
      EnvironmentId,
      { readonly failures: number; readonly retryAtMs: number }
    >();
    // Waiters whose linked threads are being read, so a burst of triggers reads them once.
    const linkedChecksInFlight = new Set<ThreadId>();

    // Snoozes that wait on threads are few, so their rows are read directly.
    const toWaiterIds = (rows: ReadonlyArray<{ readonly thread_id: string }>) =>
      rows.map((row) => ThreadId.make(row.thread_id));
    const listAllWaiterIds = (now: DateTime.Utc) =>
      sql<{ readonly thread_id: string }>`
        SELECT t.thread_id
        FROM orchestration_v2_projection_threads AS t
        WHERE t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND (
            json_array_length(t.payload_json, '$.snoozeUntilSettledThreadIds') > 0
            OR json_array_length(t.payload_json, '$.snoozeUntilSettledLinkedThreads') > 0
          )
          AND julianday(json_extract(t.payload_json, '$.snoozedUntil'))
            > julianday(${DateTime.formatIso(now)})
      `.pipe(NodeSqliteClient.readOnly, Effect.map(toWaiterIds));
    const listLinkedWaiterIds = (now: DateTime.Utc) =>
      sql<{ readonly thread_id: string }>`
        SELECT t.thread_id
        FROM orchestration_v2_projection_threads AS t
        WHERE t.deleted_at IS NULL
          AND t.archived_at IS NULL
          AND json_array_length(t.payload_json, '$.snoozeUntilSettledLinkedThreads') > 0
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

    // Reads through a link as this environment rather than as an agent, so no thread's fence applies.
    const linkScope: McpInvocationContext.McpInvocationScope = {
      environmentId: hereId,
      requestNamespace: "snooze-until-settled",
      thread: undefined,
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };

    const recordLinkedOutcome = Effect.fn("SnoozeUntilSettledWorker.recordLinkedOutcome")(
      function* (environmentId: EnvironmentId, answered: boolean) {
        if (answered) {
          backoffByEnvironment.delete(environmentId);
          return;
        }
        const failures = (backoffByEnvironment.get(environmentId)?.failures ?? 0) + 1;
        const delay = Duration.min(
          Duration.times(LINKED_POLL_INTERVAL, 2 ** (failures - 1)),
          LINKED_MAX_BACKOFF,
        );
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        backoffByEnvironment.set(environmentId, {
          failures,
          retryAtMs: nowMs + Duration.toMillis(delay),
        });
      },
    );

    /** Whether the link is forgotten here or past its expiry, so no read through it can pass. */
    const isLinkGone = Effect.fn("SnoozeUntilSettledWorker.isLinkGone")(function* (
      environmentId: EnvironmentId,
    ) {
      const link = yield* peerLinks.get(environmentId);
      if (Option.isNone(link)) return true;
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      return DateTime.toEpochMillis(link.value.expiresAt) <= nowMs;
    });

    /**
     * A thread gone there counts as done, as one deleted here does. So does a link gone for good
     * (forgotten here or expired), as the fail-safe. A refusal over a link still stored here, as
     * when it was revoked there or the peer runs an older build, may pass once the link is renewed
     * or the peer updated, so it leaves the waiter waiting like any other failure.
     */
    const linkedFailureState = Effect.fn("SnoozeUntilSettledWorker.linkedFailureState")(function* (
      ref: ScopedThreadRef,
      error: OrchestratorMcpFailure,
    ) {
      if (error.code === "thread_not_found") return "done" as const;
      const isLinkRefusal = error.code === "capability_denied" || error.code === "invalid_request";
      const linkGone = isLinkRefusal && (yield* isLinkGone(ref.environmentId));
      if (linkGone) {
        yield* Effect.logWarning("orchestration-v2.snooze-until-settled.link-gone", {
          environmentId: ref.environmentId,
          threadId: ref.threadId,
          reason: error.message,
        });
        return "done" as const;
      }
      yield* Effect.logWarning("orchestration-v2.snooze-until-settled.linked-read-failed", {
        environmentId: ref.environmentId,
        threadId: ref.threadId,
        reason: error.message,
      });
      return "unreachable" as const;
    });

    const readLinkedDependency = Effect.fn("SnoozeUntilSettledWorker.readLinkedDependency")(
      function* (ref: ScopedThreadRef) {
        // Backoff is checked once the read holds a permit, so reads queued behind a failing one
        // see the failure and skip that environment too.
        const backoff = backoffByEnvironment.get(ref.environmentId);
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (backoff !== undefined && nowMs < backoff.retryAtMs) return "unreachable" as const;

        const state: LinkedDependencyState = yield* forwarding
          .readThread(linkScope, ref.environmentId, {
            threadId: ref.threadId,
            limit: 1,
            runLimit: 1,
          })
          .pipe(
            Effect.timeout(LINKED_READ_TIMEOUT),
            Effect.map((read): LinkedDependencyState =>
              read.thread.settled || read.thread.archived ? "done" : "open",
            ),
            Effect.catchTags({
              OrchestratorMcpFailure: (error) => linkedFailureState(ref, error),
              TimeoutError: () =>
                Effect.logWarning("orchestration-v2.snooze-until-settled.linked-read-timed-out", {
                  environmentId: ref.environmentId,
                  threadId: ref.threadId,
                }).pipe(Effect.as("unreachable" as const)),
            }),
            Effect.catchDefect((defect) =>
              Effect.logWarning("orchestration-v2.snooze-until-settled.linked-read-failed", {
                environmentId: ref.environmentId,
                threadId: ref.threadId,
                defect,
              }).pipe(Effect.as("unreachable" as const)),
            ),
          );
        yield* recordLinkedOutcome(ref.environmentId, state !== "unreachable");
        return state;
      },
      (read) => linkedReads.withPermits(1)(read),
    );

    const dispatchWake = Effect.fn("SnoozeUntilSettledWorker.dispatchWake")(function* (
      waiterId: ThreadId,
      snoozedAt: DateTime.Utc,
    ) {
      // Each attempt is new: the decider re-checks the snooze, so a duplicate wake is refused.
      // Naming the checked snooze makes the decider refuse a wake of one that replaced it since.
      const uuid = yield* random.uuidV4();
      yield* orchestrator.dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make(`server:snooze-threads-settled:${waiterId}:${uuid}`),
        threadId: waiterId,
        reason: "threads_settled",
        snoozedAt: DateTime.formatIso(snoozedAt),
      });
    });

    /** Reads the waiter's linked threads in order, stopping at the first that is not done. */
    const wakeIfLinkedSettled = Effect.fn("SnoozeUntilSettledWorker.wakeIfLinkedSettled")(
      function* (
        waiterId: ThreadId,
        snoozedAt: DateTime.Utc,
        linkedThreads: ReadonlyArray<ScopedThreadRef>,
      ) {
        for (const ref of linkedThreads) {
          if ((yield* readLinkedDependency(ref)) !== "done") return;
        }
        yield* dispatchWake(waiterId, snoozedAt);
      },
    );

    const wakeIfSettled = Effect.fn("SnoozeUntilSettledWorker.wakeIfSettled")(function* (
      waiterId: ThreadId,
    ) {
      const waiter = yield* projections.getThread(waiterId);
      const now = yield* DateTime.now;
      const waiting = snoozeWaitingDependencies(waiter, DateTime.toEpochMillis(now));
      // The decider refuses to unsnooze an archived thread; unarchiving it evaluates it again.
      if (waiting === null || waiter.archivedAt !== null || waiter.deletedAt !== null) {
        return;
      }
      // Every snooze records when it was made, and the wake names it.
      const snoozedAt = waiter.snoozedAt;
      if (snoozedAt == null) {
        return yield* Effect.die(new Error(`Snoozed thread ${waiterId} has no snoozedAt.`));
      }
      const dependencies = yield* Effect.forEach(waiting.threadIds, (threadId) =>
        loadSnoozeDependency(projections, threadId),
      );
      if (!dependencies.every(isSnoozeDependencyDone)) return;
      if (waiting.linkedThreads.length === 0) {
        yield* dispatchWake(waiterId, snoozedAt);
        return;
      }

      // Linked threads are read off this path, so a slow peer never holds up wakes here.
      if (linkedChecksInFlight.has(waiterId)) return;
      linkedChecksInFlight.add(waiterId);
      yield* wakeIfLinkedSettled(waiterId, snoozedAt, waiting.linkedThreads).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.snooze-until-settled.wake-failed", {
            threadId: waiterId,
            cause,
          }),
        ),
        Effect.ensuring(Effect.sync(() => linkedChecksInFlight.delete(waiterId))),
        Effect.forkIn(workerScope),
      );
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
    const wakeLinkedWaiters = Effect.fn("SnoozeUntilSettledWorker.wakeLinkedWaiters")(function* () {
      yield* wakeEach(yield* listLinkedWaiterIds(yield* DateTime.now));
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
    // Linked threads settle where no event here shows it, so their waiters are read again.
    yield* forkParked(
      Effect.sleep(LINKED_POLL_INTERVAL).pipe(
        Effect.andThen(wakeLinkedWaiters()),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.snooze-until-settled.poll-failed", { cause }),
        ),
        Effect.forever,
      ),
    );
  }),
);
