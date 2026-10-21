import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2,
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as QuotaReserve from "./QuotaReserve.ts";
import * as QuotaReserveAdapterRegistry from "./QuotaReserveAdapterRegistry.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex_test");
const threadId = ThreadId.make("thread:quota-reserve-adapter");
const runId = RunId.make("run:quota-reserve-adapter");
const attemptId = RunAttemptId.make("attempt:quota-reserve-adapter");
const providerSessionId = ProviderSessionId.make("session:quota-reserve-adapter");
const providerThreadId = ProviderThreadId.make("provider-thread:quota-reserve-adapter");
const providerTurnId = ProviderTurnId.make("provider-turn:quota-reserve-adapter");
const nodeId = NodeId.make("node:quota-reserve-adapter");

interface ActiveTurnState {
  readonly latestItemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure | undefined;
  readonly interrupt: Effect.Effect<void, never>;
}

const makeQuotaReserve = Effect.fn("QuotaReserveAdapterRegistryTest.makeQuotaReserve")(
  function* () {
    const turnActivated = yield* Deferred.make<void>();
    const startingBaseOrdinals = yield* Ref.make(new Map<RunAttemptId, number>());
    const activeTurns = yield* Ref.make(new Map<ProviderTurnId, ActiveTurnState>());

    const service: QuotaReserve.QuotaReserveShape = {
      evaluate: () => Effect.succeed({ type: "allow" }),
      authorize: () => Effect.succeed(false),
      isEnabled: () => Effect.succeed(true),
      registerStartingTurn: (turn) =>
        Ref.update(startingBaseOrdinals, (current) =>
          new Map(current).set(turn.attemptId, turn.baseItemOrdinal),
        ),
      clearStartingTurn: (_instanceId, targetAttemptId) =>
        Ref.update(startingBaseOrdinals, (current) => {
          const next = new Map(current);
          next.delete(targetAttemptId);
          return next;
        }),
      activateTurn: (input) =>
        Effect.gen(function* () {
          const baseItemOrdinal = yield* Ref.modify(startingBaseOrdinals, (current) => {
            const ordinal = current.get(input.attemptId);
            const next = new Map(current);
            next.delete(input.attemptId);
            return [ordinal, next] as const;
          });
          if (baseItemOrdinal === undefined) {
            return yield* Effect.die("Turn activation was not registered.");
          }
          yield* Ref.update(activeTurns, (current) =>
            new Map(current).set(input.providerTurnId, {
              latestItemOrdinal: baseItemOrdinal,
              failure: undefined,
              interrupt: input.interrupt.pipe(Effect.orDie),
            }),
          );
          yield* Deferred.succeed(turnActivated, undefined);
        }),
      observeTurnItem: (_instanceId, targetProviderTurnId, ordinal) =>
        Ref.update(activeTurns, (current) => {
          const turn = current.get(targetProviderTurnId);
          if (turn === undefined || turn.latestItemOrdinal >= ordinal) return current;
          return new Map(current).set(targetProviderTurnId, {
            ...turn,
            latestItemOrdinal: ordinal,
          });
        }),
      activeTurns: () =>
        Ref.get(activeTurns).pipe(
          Effect.map((current) =>
            [...current.keys()].map((targetProviderTurnId) => ({
              trackingId: String(targetProviderTurnId),
              instanceId,
              threadId,
              providerTurnId: targetProviderTurnId,
            })),
          ),
        ),
      flagReserveStop: (trackingId, failure) =>
        Ref.modify(activeTurns, (current) => {
          const entry = [...current.entries()].find(
            ([targetProviderTurnId]) => String(targetProviderTurnId) === trackingId,
          );
          if (entry === undefined) return [undefined, current] as const;
          const [targetProviderTurnId, turn] = entry;
          return [
            turn.interrupt,
            new Map(current).set(targetProviderTurnId, { ...turn, failure }),
          ] as const;
        }),
      finishTurn: (_instanceId, targetProviderTurnId) =>
        Ref.modify(activeTurns, (current) => {
          const turn = current.get(targetProviderTurnId);
          if (turn === undefined) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(targetProviderTurnId);
          return [
            {
              failure: turn.failure,
              failureItemOrdinal: turn.latestItemOrdinal + 1,
            },
            next,
          ] as const;
        }),
    };

    return { service, turnActivated };
  },
);

function makeProviderThread(now: DateTime.Utc): OrchestrationV2ProviderThread {
  return {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeTurnInput(
  now: DateTime.Utc,
  providerThread: OrchestrationV2ProviderThread,
): ProviderAdapterV2TurnInput {
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:quota-reserve-adapter"),
      title: "Quota reserve adapter",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: providerThreadId,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId,
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: nodeId,
    providerThread,
    message: {
      messageId: MessageId.make("message:quota-reserve-adapter"),
      text: "Test",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: { instanceId, model: "gpt-test" },
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
    },
  };
}

function providerTurnEvent(now: DateTime.Utc): ProviderAdapterV2Event {
  return {
    type: "provider_turn.updated",
    driver,
    threadId,
    providerTurn: {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  };
}

function turnItemEvent(now: DateTime.Utc): ProviderAdapterV2Event {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make("turn-item:quota-reserve-adapter"),
      threadId,
      runId,
      nodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 147,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "reasoning",
      text: "Done",
      streaming: false,
    },
  };
}

function interruptedTerminal(): ProviderAdapterV2Event {
  return {
    type: "turn.terminal",
    driver,
    providerThreadId,
    providerTurnId,
    runOrdinal: 1,
    status: "interrupted",
    failure: null,
    threadDisposition: "reusable",
  };
}

const runRewriteScenario = Effect.fn("QuotaReserveAdapterRegistryTest.runRewriteScenario")(
  function* (input: {
    readonly isFlagged: boolean;
    readonly isCompact: boolean;
    readonly endsWithTerminal?: boolean;
  }) {
    const now = yield* DateTime.now;
    const queue = yield* Queue.unbounded<ProviderAdapterV2Event>();
    const wasInterrupted = yield* Ref.make(false);
    const providerThread = makeProviderThread(now);
    const runtime: ProviderAdapterV2SessionRuntime = {
      instanceId,
      driver,
      providerSessionId,
      providerSession: {
        id: providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "running",
        cwd: "/workspace",
        model: "gpt-test",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.fromQueue(queue),
      ensureThread: () => Effect.die("unused ensureThread"),
      resumeThread: () => Effect.die("unused resumeThread"),
      startTurn: () => Effect.void,
      compactThread: () => Effect.void,
      steerTurn: () => Effect.die("unused steerTurn"),
      interruptTurn: () => Ref.set(wasInterrupted, true),
      respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
      readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
      rollbackThread: () => Effect.die("unused rollbackThread"),
      forkThread: () => Effect.die("unused forkThread"),
    };
    const adapter: ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.die("unused getCapabilities"),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.succeed(runtime),
    };
    const quotaReserve = yield* makeQuotaReserve();
    const layer = QuotaReserveAdapterRegistry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ProviderAdapterRegistry.layerSingle(adapter),
          Layer.succeed(QuotaReserve.QuotaReserve, quotaReserve.service),
        ),
      ),
    );

    const scenario = yield* Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const decoratedAdapter = yield* registry.get(instanceId);
        const decoratedRuntime = yield* decoratedAdapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: { instanceId, model: "gpt-test" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const turnInput = makeTurnInput(now, providerThread);
        if (input.isCompact) {
          yield* decoratedRuntime.compactThread!(turnInput);
        }
        if (!input.isCompact) {
          yield* decoratedRuntime.startTurn(turnInput);
        }

        const collected = yield* decoratedRuntime.events.pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Queue.offer(queue, providerTurnEvent(now));
        yield* Deferred.await(quotaReserve.turnActivated);
        if (input.endsWithTerminal === false) {
          yield* Fiber.interrupt(collected);
          return { events: [], wasInterrupted: yield* Ref.get(wasInterrupted) };
        }

        if (input.isFlagged) {
          const [active] = yield* quotaReserve.service.activeTurns(instanceId);
          if (active === undefined) return yield* Effect.die("Expected an active turn.");
          const failure = makeProviderFailure({
            class: "usage_limit",
            code: "quota_reserve",
            retryable: false,
            resetAt: "2026-10-06T15:00:00.000Z",
            message: "Quota reserve reached.",
          });
          yield* quotaReserve.service.flagReserveStop(active.trackingId, failure);
        }

        yield* Queue.offer(queue, turnItemEvent(now));
        yield* Queue.offer(queue, interruptedTerminal());
        return {
          events: [...(yield* Fiber.join(collected))],
          wasInterrupted: yield* Ref.get(wasInterrupted),
        };
      }).pipe(Effect.provide(layer)),
    );
    return { ...scenario, activeTurns: yield* quotaReserve.service.activeTurns(instanceId) };
  },
);

it.effect("rewrites a reserve-flagged interrupted terminal as a reusable usage limit", () =>
  Effect.gen(function* () {
    const result = yield* runRewriteScenario({ isFlagged: true, isCompact: false });
    const terminal = result.events[2];

    assert.strictEqual(terminal?.type, "turn.terminal");
    if (terminal?.type !== "turn.terminal") return;
    assert.strictEqual(terminal.status, "failed");
    if (terminal.status !== "failed") return;
    assert.strictEqual(terminal.failure.class, "usage_limit");
    assert.strictEqual(terminal.failure.code, "quota_reserve");
    assert.strictEqual(terminal.failureItemOrdinal, 148);
    assert.strictEqual(terminal.threadDisposition, "reusable");
    assert.isEmpty(result.activeTurns);
    assert.isFalse(result.wasInterrupted);
  }),
);

it.effect("passes an unflagged interrupted terminal through after a compact turn", () =>
  Effect.gen(function* () {
    const result = yield* runRewriteScenario({ isFlagged: false, isCompact: true });
    const terminal = result.events[2];

    assert.deepEqual(terminal, interruptedTerminal());
    assert.isEmpty(result.activeTurns);
  }),
);

it.effect("forgets a running turn when its session closes without a terminal", () =>
  Effect.gen(function* () {
    const result = yield* runRewriteScenario({
      isFlagged: false,
      isCompact: false,
      endsWithTerminal: false,
    });

    assert.isEmpty(result.activeTurns);
  }),
);
