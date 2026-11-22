import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  type PeerLink,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScopedThreadRef,
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  ThreadId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SnoozeUntilSettledWorker from "./SnoozeUntilSettledWorker.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for snooze controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const makeLayerTest = (
  wrapProjectionStore?: (
    store: ProjectionStore.ProjectionStoreV2Shape,
  ) => ProjectionStore.ProjectionStoreV2Shape,
) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    layerDatabase,
    NodeCrypto.layer,
    // The worker reads this store; `wrapProjectionStore` gates only the orchestrator's reads.
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "snooze-until-settled" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: layerDatabase,
        runEffectWorker: false,
        ...(wrapProjectionStore === undefined ? {} : { wrapProjectionStore }),
      },
    ),
  );
};
const layerTest = makeLayerTest();

const HOUR_MS = 60 * 60 * 1000;

const linkedEnvironmentId = EnvironmentId.make("environment:box");
const linkedThread = (name: string): ScopedThreadRef => ({
  environmentId: linkedEnvironmentId,
  threadId: ThreadId.make(`thread:box-${name}`),
});

/** Stores a link to `linkedEnvironmentId`, as linking would; only its row is read here. */
const storeLink = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO peer_environment_links
      (environment_id, secret_name, label, urls_json, access, linked_at, expires_at, fenced)
    VALUES
      (${linkedEnvironmentId}, 'peer-link:box', 'box', '[]', 'full-access',
       '2099-01-01T00:00:00.000Z', '2099-02-01T00:00:00.000Z', 1)
  `;
});

/** What the linked environment answers to one read of a thread there. */
type LinkedReadOutcome = "open" | "settled" | "archived" | OrchestratorMcpFailure;
interface LinkedRead {
  readonly ref: ScopedThreadRef;
  readonly respond: Deferred.Deferred<LinkedReadOutcome>;
}

const readResult = (outcome: "open" | "settled" | "archived") =>
  ({
    thread: { settled: outcome === "settled", archived: outcome === "archived" },
    recentRuns: [],
    items: [],
    nextPosition: null,
    hasMore: false,
  }) as unknown as OrchestratorMcpThreadReadResult;

const layerHere = Layer.mock(ServerEnvironment.ServerEnvironment)({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:here")),
});
/** The stored links, read from the rows `storeLink` writes; the worker reads only their expiry. */
const layerPeerLinks = Layer.unwrap(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return Layer.mock(PeerLinks.PeerLinks)({
      get: (environmentId) =>
        sql<{ readonly expires_at: string }>`
          SELECT expires_at FROM peer_environment_links WHERE environment_id = ${environmentId}
        `.pipe(
          Effect.map((rows) =>
            rows.length === 0
              ? Option.none()
              : Option.some({
                  expiresAt: DateTime.makeUnsafe(rows[0]!.expires_at),
                } as PeerLink),
          ),
          Effect.orDie,
        ),
    });
  }),
);
/** The worker with no linked environment to read: a read would fail the test. */
const layerWorker = SnoozeUntilSettledWorker.layer.pipe(
  Layer.provide(
    Layer.mergeAll(Layer.mock(PeerForwarding.PeerForwarding)({}), layerHere, layerPeerLinks),
  ),
);
/** The worker reading linked threads through `reads`, each answered by the test. */
const layerLinkedWorker = (reads: Queue.Queue<LinkedRead>) =>
  SnoozeUntilSettledWorker.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerForwarding.PeerForwarding)({
          readThread: (_scope, environmentId, input) =>
            Effect.gen(function* () {
              const respond = yield* Deferred.make<LinkedReadOutcome>();
              yield* Queue.offer(reads, {
                ref: { environmentId, threadId: input.threadId },
                respond,
              });
              const outcome = yield* Deferred.await(respond);
              if (typeof outcome !== "string") return yield* outcome;
              return readResult(outcome);
            }),
        }),
        layerHere,
        layerPeerLinks,
      ),
    ),
  );

/** Takes the worker's next read, checks which thread it is for, and answers it. */
const answerRead = Effect.fn("SnoozeUntilSettledWorkerTest.answerRead")(function* (
  reads: Queue.Queue<LinkedRead>,
  ref: ScopedThreadRef,
  outcome: LinkedReadOutcome,
) {
  const read = yield* Queue.take(reads);
  assert.deepEqual(read.ref, ref);
  yield* Deferred.succeed(read.respond, outcome);
});

const createThread = Effect.fn("SnoozeUntilSettledWorkerTest.createThread")(function* (
  name: string,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make("project:snooze-until-settled"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const snoozeUntilSettled = Effect.fn("SnoozeUntilSettledWorkerTest.snoozeUntilSettled")(function* (
  threadId: ThreadId,
  untilSettledThreadIds: ReadonlyArray<ThreadId>,
  wakeAfterMs = THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  untilSettledLinkedThreads: ReadonlyArray<ScopedThreadRef> = [],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const capAt = DateTime.add(yield* DateTime.now, { milliseconds: wakeAfterMs });
  const linkedKeys = untilSettledLinkedThreads.map((ref) => `${ref.environmentId}/${ref.threadId}`);
  return yield* orchestrator.dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(
      `snooze-${threadId}-${untilSettledThreadIds.join(",")}-${linkedKeys.join(",")}-${wakeAfterMs}`,
    ),
    threadId,
    snoozedUntil: DateTime.formatIso(capAt),
    ...(untilSettledThreadIds.length === 0 ? {} : { untilSettledThreadIds }),
    ...(untilSettledLinkedThreads.length === 0 ? {} : { untilSettledLinkedThreads }),
  });
});

const dispatchThreadsSettled = Effect.fn("SnoozeUntilSettledWorkerTest.dispatchThreadsSettled")(
  // Names the waiter's current snooze unless the test names an older one.
  function* (threadId: ThreadId, name: string, checkedSnoozedAt?: DateTime.Utc) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const before = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId);
    const snoozedAt = checkedSnoozedAt ?? before.snoozedAt;
    const result = yield* orchestrator
      .dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make(`threads-settled-${name}`),
        threadId,
        reason: "threads_settled",
        ...(snoozedAt == null ? {} : { snoozedAt: DateTime.formatIso(snoozedAt) }),
      })
      .pipe(Effect.result);
    const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(threadId);
    return { accepted: Result.isSuccess(result), thread };
  },
);

// The waiter's next unsnooze, read from the event log so a wake committed earlier is not missed.
const nextUnsnooze = Effect.fn("SnoozeUntilSettledWorkerTest.nextUnsnooze")(function* (
  threadId: ThreadId,
  afterSequence: number,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const event = yield* eventSink.stream({ afterSequence, eventType: "thread.unsnoozed" }).pipe(
    Stream.filter((stored) => stored.event.threadId === threadId),
    Stream.runHead,
  );
  assert.isTrue(Option.isSome(event));
  return Option.getOrThrow(event);
});

it.effect("rejects lists that could never wake the snooze early", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("reject-waiter");
    const other = yield* createThread("reject-other");
    const settled = yield* createThread("reject-settled");
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("reject-settle"),
      threadId: settled,
    });
    // `other` waits on `waiter`, so `waiter` waiting on `other` would never wake.
    yield* snoozeUntilSettled(other, [waiter]);

    const rejections: Array<[ReadonlyArray<ThreadId>, string, number?]> = [
      [[waiter], "cannot wait on itself"],
      [[ThreadId.make("thread:missing")], "does not exist"],
      [[settled], "already settled, archived, or deleted"],
      [[settled, other], "already waits on thread"],
      // Past the cap and the hour of clock skew it allows.
      [[settled, other], "at most 30 days out", THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS + 2 * HOUR_MS],
    ];
    for (const [threadIds, cause, wakeAfterMs] of rejections) {
      const error = yield* snoozeUntilSettled(waiter, threadIds, wakeAfterMs).pipe(Effect.flip);
      assert.include(String(error.cause), cause);
    }
    const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
    assert.isNull(thread.snoozedUntil);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("accepts linked threads only through a stored link, without reading them", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const waiter = yield* createThread("linked-accept-waiter");
    const linkedOnly = yield* createThread("linked-accept-only");
    const settled = yield* createThread("linked-accept-settled");
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("linked-accept-settle"),
      threadId: settled,
    });
    const unlinked = yield* snoozeUntilSettled(waiter, [], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
      linkedThread("a"),
    ]).pipe(Effect.flip);
    assert.include(String(unlinked.cause), "is not linked from this environment");

    yield* storeLink;
    // The cap counts both lists together.
    const tooMany = yield* snoozeUntilSettled(
      waiter,
      [settled],
      THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
      Array.from({ length: 50 }, (_, index) => linkedThread(`many-${index}`)),
    ).pipe(Effect.flip);
    assert.include(String(tooMany.cause), "at most 50 threads");

    // A linked thread counts as open here, so a settled thread beside it does not refuse the wait.
    yield* snoozeUntilSettled(waiter, [settled], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
      linkedThread("a"),
      linkedThread("a"),
    ]);
    const mixed = yield* projections.getThread(waiter);
    assert.deepEqual(mixed.snoozeUntilSettledThreadIds, [settled]);
    assert.deepEqual(mixed.snoozeUntilSettledLinkedThreads, [linkedThread("a")]);

    yield* snoozeUntilSettled(linkedOnly, [], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
      linkedThread("b"),
    ]);
    const only = yield* projections.getThread(linkedOnly);
    assert.isNull(only.snoozeUntilSettledThreadIds);
    assert.deepEqual(only.snoozeUntilSettledLinkedThreads, [linkedThread("b")]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("wakes only once every listed thread is done, keeping the list for the label", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("wake-waiter");
    const first = yield* createThread("wake-first");
    const second = yield* createThread("wake-second");
    yield* snoozeUntilSettled(waiter, [first, second, first]);
    const snoozed = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
    assert.deepEqual(snoozed.snoozeUntilSettledThreadIds, [first, second]);

    // One done thread is not enough, and a reopened one counts as open again.
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("wake-settle-first"),
      threadId: first,
    });
    const oneDone = yield* dispatchThreadsSettled(waiter, "one-done");
    assert.isFalse(oneDone.accepted);
    assert.deepEqual(oneDone.thread.snoozedUntil, snoozed.snoozedUntil);
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make("wake-unsettle-first"),
      threadId: first,
      reason: "user",
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("wake-archive-second"),
      threadId: second,
    });
    const reopened = yield* dispatchThreadsSettled(waiter, "reopened");
    assert.isFalse(reopened.accepted);
    assert.deepEqual(reopened.thread.snoozedUntil, snoozed.snoozedUntil);

    // Deleting the last one wakes it like an expired timer.
    yield* TestClock.adjust("1 minute");
    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("wake-delete-first"),
      threadId: first,
    });
    const allDone = yield* dispatchThreadsSettled(waiter, "all-done");
    assert.isTrue(allDone.accepted);
    const woke = allDone.thread;
    assert.deepEqual(woke.snoozedUntil, yield* DateTime.now);
    assert.deepEqual(woke.snoozedAt, snoozed.snoozedAt);
    assert.deepEqual(woke.snoozeUntilSettledThreadIds, [first, second]);

    // An ended snooze stays as it is.
    yield* TestClock.adjust("1 minute");
    const again = yield* dispatchThreadsSettled(waiter, "again");
    assert.isFalse(again.accepted);
    assert.deepEqual(again.thread.snoozedUntil, woke.snoozedUntil);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a wake that names a replaced snooze leaves the new one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("replaced-waiter");
    const first = yield* createThread("replaced-first");
    const second = yield* createThread("replaced-second");
    yield* storeLink;
    yield* snoozeUntilSettled(waiter, [first, second]);
    const checked = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("replaced-settle-first"),
      threadId: first,
    });

    // A new snooze replaced the checked one before the wake. Its threads here are all done and the
    // decider leaves its linked thread to the worker, so only the named snooze refuses the wake.
    yield* TestClock.adjust("1 minute");
    yield* snoozeUntilSettled(waiter, [first], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
      linkedThread("replaced"),
    ]);
    const stale = yield* dispatchThreadsSettled(waiter, "stale", checked.snoozedAt ?? undefined);
    assert.isFalse(stale.accepted);
    assert.deepEqual(stale.thread.snoozeUntilSettledLinkedThreads, [linkedThread("replaced")]);

    // A wake that names no snooze is refused too.
    const unnamed = yield* orchestrator
      .dispatch({
        type: "thread.unsnooze",
        commandId: CommandId.make("replaced-unnamed"),
        threadId: waiter,
        reason: "threads_settled",
      })
      .pipe(Effect.result);
    assert.isFalse(Result.isSuccess(unnamed));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the cap ends the wait like a time snooze", () =>
  Effect.gen(function* () {
    const waiter = yield* createThread("cap-waiter");
    const dependency = yield* createThread("cap-dependency");
    yield* snoozeUntilSettled(waiter, [dependency]);
    const snoozed = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
    yield* TestClock.adjust(THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS + 1);
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.settle",
      commandId: CommandId.make("cap-settle"),
      threadId: dependency,
    });
    const capped = yield* dispatchThreadsSettled(waiter, "cap");
    assert.isFalse(capped.accepted);
    assert.deepEqual(capped.thread.snoozedUntil, snoozed.snoozedUntil);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  {
    name: "time snooze",
    command: (threadId: ThreadId): OrchestrationV2Command => ({
      type: "thread.snooze",
      commandId: CommandId.make(`clear-time-${threadId}`),
      threadId,
      snoozedUntil: "2099-07-25T09:00:00.000Z",
    }),
  },
  {
    name: "unsnooze",
    command: (threadId: ThreadId): OrchestrationV2Command => ({
      type: "thread.unsnooze",
      commandId: CommandId.make(`clear-unsnooze-${threadId}`),
      threadId,
      reason: "user",
    }),
  },
  {
    name: "settle",
    command: (threadId: ThreadId): OrchestrationV2Command => ({
      type: "thread.settle",
      commandId: CommandId.make(`clear-settle-${threadId}`),
      threadId,
    }),
  },
  {
    name: "pin",
    command: (threadId: ThreadId): OrchestrationV2Command => ({
      type: "thread.pin",
      commandId: CommandId.make(`clear-pin-${threadId}`),
      threadId,
    }),
  },
  {
    name: "human message",
    command: (threadId: ThreadId): OrchestrationV2Command => ({
      type: "message.dispatch",
      commandId: CommandId.make(`clear-message-${threadId}`),
      threadId,
      messageId: MessageId.make(`clear-message-${threadId}`),
      text: "Back to this one",
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    }),
  },
])("$name clears the threads a snooze waits on", ({ name, command }) =>
  Effect.gen(function* () {
    const slug = name.replaceAll(" ", "-");
    const waiter = yield* createThread(`clear-${slug}-waiter`);
    const dependency = yield* createThread(`clear-${slug}-dependency`);
    yield* storeLink;
    yield* snoozeUntilSettled(waiter, [dependency], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
      linkedThread("clear"),
    ]);
    yield* (yield* Orchestrator.OrchestratorV2).dispatch(command(waiter));
    const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
    assert.isNull(thread.snoozeUntilSettledThreadIds);
    assert.isNull(thread.snoozeUntilSettledLinkedThreads);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the worker wakes a waiter when its last dependency settles", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("worker-waiter");
    const first = yield* createThread("worker-first");
    const second = yield* createThread("worker-second");
    yield* snoozeUntilSettled(waiter, [first, second]);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("worker-archive-first"),
      threadId: first,
    });

    yield* Effect.gen(function* () {
      const settled = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("worker-settle-second"),
        threadId: second,
      });
      const wake = yield* nextUnsnooze(waiter, settled.sequence);
      assert.equal(wake.commandId?.startsWith("server:snooze-threads-settled:"), true);
      assert.deepEqual(
        (yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter)).snoozedUntil,
        yield* DateTime.now,
      );
    }).pipe(Effect.provide(layerWorker));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the startup sweep wakes a waiter whose dependencies settled while stopped", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("sweep-waiter");
    const dependency = yield* createThread("sweep-dependency");
    yield* snoozeUntilSettled(waiter, [dependency]);
    const settled = yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make("sweep-settle"),
      threadId: dependency,
    });

    yield* nextUnsnooze(waiter, settled.sequence).pipe(Effect.provide(layerWorker));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the worker wakes a waiter when it is unarchived after its dependency settled", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const waiter = yield* createThread("unarchive-waiter");
    const dependency = yield* createThread("unarchive-dependency");
    yield* snoozeUntilSettled(waiter, [dependency]);
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("unarchive-archive-waiter"),
      threadId: waiter,
    });

    yield* Effect.gen(function* () {
      // The settle finds no waiter to wake: an archived thread cannot be unsnoozed.
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("unarchive-settle"),
        threadId: dependency,
      });
      const unarchived = yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("unarchive-waiter"),
        threadId: waiter,
      });
      yield* nextUnsnooze(waiter, unarchived.sequence);
    }).pipe(Effect.provide(layerWorker));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the worker wakes a waiter whose dependency settled while its snooze was decided", () => {
  const waiter = ThreadId.make("thread:race-waiter");
  const dependency = ThreadId.make("thread:race-dependency");
  // Hands the snooze's validation the open dependency, then holds it until the dependency settles.
  const validationRead = Deferred.makeUnsafe<void>();
  const validationRelease = Deferred.makeUnsafe<void>();
  let gateArmed = false;
  const layerGatedValidation = makeLayerTest((store) => ({
    ...store,
    getThread: (id) => {
      if (!gateArmed || id !== dependency) return store.getThread(id);
      gateArmed = false;
      return store.getThread(id).pipe(
        Effect.tap(() => Deferred.succeed(validationRead, undefined)),
        Effect.tap(() => Deferred.await(validationRelease)),
      );
    },
  }));
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* createThread("race-waiter");
    yield* createThread("race-dependency");
    // The worker handles settles in order, so the probe's wake marks the race settle as handled.
    const probeWaiter = yield* createThread("race-probe-waiter");
    const probe = yield* createThread("race-probe");
    yield* snoozeUntilSettled(probeWaiter, [probe]);

    yield* Effect.gen(function* () {
      gateArmed = true;
      const snooze = yield* snoozeUntilSettled(waiter, [dependency]).pipe(Effect.forkChild);
      yield* Deferred.await(validationRead);
      // The settle commits before the snooze, so its event finds no waiter yet.
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("race-settle"),
        threadId: dependency,
      });
      const probeSettled = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("race-settle-probe"),
        threadId: probe,
      });
      yield* nextUnsnooze(probeWaiter, probeSettled.sequence);
      yield* Deferred.succeed(validationRelease, undefined);
      const snoozed = yield* Fiber.join(snooze);
      yield* nextUnsnooze(waiter, snoozed.sequence);
    }).pipe(Effect.provide(layerWorker));
  }).pipe(Effect.provide(layerGatedValidation));
});

const linkFailure = (code: OrchestratorMcpFailure["code"]) =>
  new OrchestratorMcpFailure({ code, message: `The linked environment answered ${code}.` });

it.effect.each([
  { name: "settled", outcome: "settled" as const, linkChange: null },
  { name: "archived", outcome: "archived" as const, linkChange: null },
  { name: "deleted", outcome: linkFailure("thread_not_found"), linkChange: null },
  // The link is gone for good: waking is the fail-safe, as for a deleted thread.
  {
    name: "behind an expired link",
    outcome: linkFailure("capability_denied"),
    linkChange: "expire",
  },
  {
    name: "behind a forgotten link",
    outcome: linkFailure("invalid_request"),
    linkChange: "forget",
  },
])("the worker wakes a waiter whose linked thread is $name", ({ name, outcome, linkChange }) =>
  Effect.gen(function* () {
    const slug = name.replaceAll(" ", "-");
    const reads = yield* Queue.unbounded<LinkedRead>();
    const waiter = yield* createThread(`linked-wake-${slug}-waiter`);
    const ref = linkedThread(`wake-${slug}`);
    yield* storeLink;

    yield* Effect.gen(function* () {
      const snoozed = yield* snoozeUntilSettled(waiter, [], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
        ref,
      ]);
      const sql = yield* SqlClient.SqlClient;
      if (linkChange === "forget") yield* sql`DELETE FROM peer_environment_links`;
      if (linkChange === "expire") {
        yield* sql`UPDATE peer_environment_links SET expires_at = '1969-12-31T00:00:00.000Z'`;
      }
      yield* answerRead(reads, ref, outcome);
      yield* nextUnsnooze(waiter, snoozed.sequence);
    }).pipe(Effect.provide(layerLinkedWorker(reads)));
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "does not answer", code: "orchestration_error" as const },
  // Revoked there, or a peer on an older build: renewing the link or updating the peer resumes it.
  { name: "refuses a link still stored here", code: "capability_denied" as const },
])("the worker keeps a waiter snoozed while its linked environment $name", ({ name, code }) =>
  Effect.gen(function* () {
    const slug = name.replaceAll(" ", "-");
    const reads = yield* Queue.unbounded<LinkedRead>();
    const waiter = yield* createThread(`linked-unreachable-${slug}-waiter`);
    const ref = linkedThread(`unreachable-${slug}`);
    yield* storeLink;

    yield* Effect.gen(function* () {
      const snoozed = yield* snoozeUntilSettled(waiter, [], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [
        ref,
      ]);
      const snoozedUntil = (yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter))
        .snoozedUntil;
      yield* answerRead(reads, ref, linkFailure(code));

      // The poll reads again only once the first check has ended, which left the snooze alone.
      yield* TestClock.adjust("1 minute");
      const again = yield* Queue.take(reads);
      const thread = yield* (yield* ProjectionStore.ProjectionStoreV2).getThread(waiter);
      assert.deepEqual(thread.snoozedUntil, snoozedUntil);
      yield* Deferred.succeed(again.respond, "settled");
      yield* nextUnsnooze(waiter, snoozed.sequence);
    }).pipe(Effect.provide(layerLinkedWorker(reads)));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the worker wakes a waiter on threads here and linked once both are done", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const reads = yield* Queue.unbounded<LinkedRead>();
    const waiter = yield* createThread("linked-mixed-waiter");
    const local = yield* createThread("linked-mixed-local");
    const ref = linkedThread("mixed");
    yield* storeLink;

    yield* Effect.gen(function* () {
      yield* snoozeUntilSettled(waiter, [local], THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS, [ref]);
      // Settling the thread here reads the linked one, which is still open.
      const settled = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("linked-mixed-settle"),
        threadId: local,
      });
      yield* answerRead(reads, ref, "open");

      // The poll reads it again and finds it settled.
      yield* TestClock.adjust("1 minute");
      yield* answerRead(reads, ref, "settled");
      yield* nextUnsnooze(waiter, settled.sequence);
    }).pipe(Effect.provide(layerLinkedWorker(reads)));
  }).pipe(Effect.provide(layerTest)),
);
