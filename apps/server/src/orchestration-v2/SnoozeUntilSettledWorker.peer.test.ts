import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type OrchestratorMcpFailure,
  type OrchestratorMcpThreadReadResult,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScopedThreadRef,
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SnoozeUntilSettledWorker from "./SnoozeUntilSettledWorker.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// A thread on the laptop snoozes until a thread on the box settles. The box is
// its real `/mcp` behind real OAuth on a real socket; the laptop reads it
// through its real link, so every failure reaches the worker as the link
// client translates it.

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const boxThread: ScopedThreadRef = {
  environmentId: box.environmentId,
  threadId: ThreadId.make("thread:box-dependency"),
};

/** The box's one thread, idle, and settled once the test says so. */
const boxThreads = (settled: Ref.Ref<boolean>) => {
  const shellOf = (threadId: ThreadId) =>
    Ref.get(settled).pipe(
      Effect.map((isSettled): OrchestrationV2ThreadShell | null =>
        threadId === boxThread.threadId
          ? {
              ...liveThreadShell(threadId, { activeRunId: null }),
              status: "idle",
              settledOverride: isSettled ? "settled" : null,
              settledAt: isSettled ? DateTime.makeUnsafe(0) : null,
            }
          : null,
      ),
    );
  const projectionOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((shell) => (shell === null ? (null as never) : idleThreadProjection(shell))),
    );
  return Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: shellOf,
    getProjectThreadRecords: (input) => projectionOf(input.threadId),
    getRunCount: (threadId) =>
      projectionOf(threadId).pipe(Effect.map((projection) => projection.runs.length)),
    getTimelinePage: () =>
      Effect.succeed({ items: [], totalItems: 0, hasMore: false, hasEarlier: false }),
  });
};

/** The box: the real orchestrator toolkit over `boxThreads`, served for links. */
const serveBox = (settled: Ref.Ref<boolean>) =>
  servePeer(
    box,
    McpHttpServer.layerOrchestratorToolkit.pipe(
      Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Layer.provide(NodeCrypto.layer),
      Layer.provide(boxThreads(settled)),
      Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-snooze-linked-box-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provide(NodeServices.layer),
      Layer.provide(
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ),
      Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
      Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
      Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
      Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
      Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
      Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    ),
  );

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for snooze controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/**
 * The laptop: its links and its orchestrator on one database, so the link the
 * test makes is the one the snooze's decider checks and the worker reads through.
 */
const makeLaptop = Effect.gen(function* () {
  const database = yield* SqlitePersistence.layerMemory.pipe(Layer.build);
  const layerDatabase = Layer.succeedContext(database);
  const linking = yield* layerLinkingEnvironment(
    laptop,
    ServerSecretStore.layer,
    layerDatabase,
  ).pipe(Layer.build);
  const orchestration = yield* Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "snooze-until-settled-linked" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(Layer.build);
  return Context.merge(linking, orchestration);
});

/** One read of the box's thread through the link, as it ended. */
type LinkedRead = Exit.Exit<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;

/**
 * The worker on the real forwarding, which reports each read once it ends, so
 * the test moves the clock only while no read is crossing the socket.
 */
const layerWorker = (reads: Queue.Queue<LinkedRead>) =>
  SnoozeUntilSettledWorker.layer.pipe(
    Layer.provide(
      Layer.effect(
        PeerForwarding.PeerForwarding,
        Effect.gen(function* () {
          const forwarding = yield* PeerForwarding.PeerForwarding;
          return {
            ...forwarding,
            readThread: (scope, environmentId, input) =>
              forwarding
                .readThread(scope, environmentId, input)
                .pipe(Effect.onExit((exit) => Queue.offer(reads, exit))),
          };
        }),
      ).pipe(Layer.provide(PeerForwarding.layer)),
    ),
    // The worker reads as this environment, not as a thread, so no thread here is looked up.
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  );

/** The worker's next read of the box's thread, which must have answered. */
const nextAnswer = Effect.fn("SnoozeUntilSettledWorkerPeerTest.nextAnswer")(function* (
  reads: Queue.Queue<LinkedRead>,
) {
  return yield* Queue.take(reads).pipe(Effect.flatten);
});

/** The worker's next read of the box's thread, which must have failed. */
const nextFailure = Effect.fn("SnoozeUntilSettledWorkerPeerTest.nextFailure")(function* (
  reads: Queue.Queue<LinkedRead>,
) {
  return yield* Queue.take(reads).pipe(Effect.flatten, Effect.flip);
});

const createWaiter = Effect.fn("SnoozeUntilSettledWorkerPeerTest.createWaiter")(function* (
  name: string,
) {
  const threadId = ThreadId.make(`thread:${name}`);
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make("project:snooze-until-settled-linked"),
    title: name,
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const snoozeUntilBoxThreadSettles = Effect.fn(
  "SnoozeUntilSettledWorkerPeerTest.snoozeUntilBoxThreadSettles",
)(function* (threadId: ThreadId) {
  const capAt = DateTime.add(yield* DateTime.now, {
    milliseconds: THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  });
  return yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(`snooze-${threadId}`),
    threadId,
    snoozedUntil: DateTime.formatIso(capAt),
    untilSettledLinkedThreads: [boxThread],
  });
});

const snoozedUntilOf = (threadId: ThreadId) =>
  ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThread(threadId)),
    Effect.map((thread) => thread.snoozedUntil),
  );

// The waiter's next unsnooze, read from the event log so a wake committed earlier is not missed.
const nextUnsnooze = Effect.fn("SnoozeUntilSettledWorkerPeerTest.nextUnsnooze")(function* (
  threadId: ThreadId,
  afterSequence: number,
) {
  const event = yield* (yield* EventSink.EventSinkV2)
    .stream({ afterSequence, eventType: "thread.unsnoozed" })
    .pipe(
      Stream.filter((stored) => stored.event.threadId === threadId),
      Stream.runHead,
    );
  assert.isTrue(Option.isSome(event));
});

it.effect("the worker wakes a waiter once its thread on a linked machine settles there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const boxSettled = yield* Ref.make(false);
      const served = yield* serveBox(boxSettled);
      const here = yield* makeLaptop;
      yield* linkTo(Context.get(here, PeerLinks.PeerLinks), served, "auto");
      const reads = yield* Queue.unbounded<LinkedRead>();

      yield* Effect.gen(function* () {
        const waiter = yield* createWaiter("linked-settles-waiter");
        yield* Effect.gen(function* () {
          // The new snooze reads the box's thread, which is still open there.
          const snoozed = yield* snoozeUntilBoxThreadSettles(waiter);
          assert.isFalse((yield* nextAnswer(reads)).thread.settled);

          // The poll reads it again and finds it settled.
          yield* Ref.set(boxSettled, true);
          yield* TestClock.adjust("1 minute");
          assert.isTrue((yield* nextAnswer(reads)).thread.settled);
          yield* nextUnsnooze(waiter, snoozed.sequence);
        }).pipe(Effect.provide(layerWorker(reads)));
      }).pipe(Effect.provide(Layer.succeedContext(here)));
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

// A peer briefly on an older build refuses the link as one it cannot keep within its limits.
// Updating it there resumes the link, so only forgetting the link here ends the wait.
it.effect.each(["linkFence", "mcpModeLimitHeader"] as const)(
  "the worker keeps a waiter snoozed while the linked machine lacks %s, until the link is forgotten",
  (capability) =>
    Effect.scoped(
      Effect.gen(function* () {
        const served = yield* serveBox(yield* Ref.make(false));
        const here = yield* makeLaptop;
        const links = Context.get(here, PeerLinks.PeerLinks);
        yield* linkTo(links, served, "auto");
        const reads = yield* Queue.unbounded<LinkedRead>();

        yield* Effect.gen(function* () {
          const waiter = yield* createWaiter(`linked-older-build-${capability}-waiter`);
          yield* Effect.gen(function* () {
            const snoozed = yield* snoozeUntilBoxThreadSettles(waiter);
            assert.isFalse((yield* nextAnswer(reads)).thread.settled);
            const snoozedUntil = yield* snoozedUntilOf(waiter);

            // The box moves to an older build, so the link refuses to carry the read.
            yield* Ref.set(
              served.descriptor,
              descriptorOf(box.environmentId, box.label, {
                [capability]: false,
              }),
            );
            yield* TestClock.adjust("1 minute");
            const refused = yield* nextFailure(reads);
            assert.equal(refused.code, "capability_denied");
            assert.include(refused.message, "cannot keep a linked agent's limits");

            // The next poll still finds the waiter snoozed, and reads the box again.
            yield* TestClock.adjust("1 minute");
            assert.deepEqual(yield* snoozedUntilOf(waiter), snoozedUntil);
            assert.equal((yield* nextFailure(reads)).code, "capability_denied");

            // Forgotten here, the link is gone for good, so the next read past the backoff wakes it.
            assert.isTrue((yield* links.unlink(box.environmentId)).removed);
            yield* TestClock.adjust("5 minutes");
            assert.equal((yield* nextFailure(reads)).code, "invalid_request");
            yield* nextUnsnooze(waiter, snoozed.sequence);
          }).pipe(Effect.provide(layerWorker(reads)));
        }).pipe(Effect.provide(Layer.succeedContext(here)));
      }),
    ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
