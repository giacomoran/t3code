import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Orchestrator from "../Orchestrator.ts";
import * as ThreadManagementService from "../ThreadManagementService.ts";
import * as QuotaReserve from "./QuotaReserve.ts";
import * as QuotaReserveThreadManagement from "./QuotaReserveThreadManagement.ts";

const threadId = ThreadId.make("thread-quota-reserve-dispatch");
const providerInstanceId = ProviderInstanceId.make("provider-quota-reserve-dispatch");
const reserveMessage =
  "Continue from where you stopped. I authorize using the quota reserve for this thread until the current five-hour window resets.";

function messageCommand(
  overrides: Partial<Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>> = {},
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> {
  return {
    type: "message.dispatch",
    commandId: CommandId.make("command-quota-reserve-dispatch"),
    threadId,
    messageId: MessageId.make("message-quota-reserve-dispatch"),
    text: "Hello",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
    ...overrides,
  };
}

function projection(input?: {
  readonly runs?: OrchestrationV2ThreadProjection["runs"];
  readonly turnItems?: OrchestrationV2ThreadProjection["turnItems"];
}) {
  return {
    thread: { providerInstanceId },
    runs: input?.runs ?? [],
    turnItems: input?.turnItems ?? [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function testLayer(input: {
  readonly currentProjection: OrchestrationV2ThreadProjection;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationV2ServerCommand>>;
  readonly authorized: Ref.Ref<
    ReadonlyArray<{ threadId: ThreadId; instanceId: ProviderInstanceId; untilIso?: string }>
  >;
  readonly reserveEnabled: boolean;
}) {
  return Layer.merge(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(input.currentProjection),
      dispatch: (command) =>
        Ref.update(input.dispatched, (commands) => [...commands, command]).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    }),
    Layer.mock(QuotaReserve.QuotaReserve)({
      isEnabled: () => Effect.succeed(input.reserveEnabled),
      authorize: (authorizedThreadId, instanceId, untilIso) =>
        Ref.update(input.authorized, (authorizations) => [
          ...authorizations,
          {
            threadId: authorizedThreadId,
            instanceId,
            ...(untilIso === undefined ? {} : { untilIso }),
          },
        ]).pipe(Effect.as(true)),
    }),
  );
}

function runWithTestServices<A, E, R>(
  effect: (service: ThreadManagementService.ThreadManagementServiceShape) => Effect.Effect<A, E, R>,
  layer: ReturnType<typeof testLayer>,
) {
  return Effect.gen(function* () {
    const service = QuotaReserveThreadManagement.decorate(
      yield* ThreadManagementService.ThreadManagementService,
      yield* QuotaReserve.QuotaReserve,
    );
    return yield* effect(service);
  }).pipe(Effect.provide(layer));
}

describe("QuotaReserveThreadManagement", () => {
  it.effect("authorizes and rewrites a text-only /reserve command", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const authorized = yield* Ref.make<
        ReadonlyArray<{ threadId: ThreadId; instanceId: ProviderInstanceId; untilIso?: string }>
      >([]);
      const command = messageCommand({ text: "  /reserve\n" });

      yield* runWithTestServices(
        (service) => service.dispatch(command),
        testLayer({
          currentProjection: projection(),
          dispatched,
          authorized,
          reserveEnabled: true,
        }),
      );

      assert.deepEqual(yield* Ref.get(authorized), [{ threadId, instanceId: providerInstanceId }]);
      assert.deepEqual(yield* Ref.get(dispatched), [{ ...command, text: reserveMessage }]);
    }),
  );

  it.effect("rejects /reserve when the provider instance has no reserve", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const authorized = yield* Ref.make<
        ReadonlyArray<{ threadId: ThreadId; instanceId: ProviderInstanceId; untilIso?: string }>
      >([]);
      const command = messageCommand({ text: "/reserve" });

      const failure = yield* Effect.flip(
        runWithTestServices(
          (service) => service.dispatch(command),
          testLayer({
            currentProjection: projection(),
            dispatched,
            authorized,
            reserveEnabled: false,
          }),
        ),
      );

      assert.instanceOf(failure, Orchestrator.OrchestratorDispatchError);
      assert.deepEqual(yield* Ref.get(authorized), []);
      assert.deepEqual(yield* Ref.get(dispatched), []);
    }),
  );

  it.effect("authorizes a quota-reserve continuation only until the stopped window resets", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const authorized = yield* Ref.make<
        ReadonlyArray<{ threadId: ThreadId; instanceId: ProviderInstanceId; untilIso?: string }>
      >([]);
      const runId = RunId.make("run-quota-reserve-dispatch");
      const rootNodeId = NodeId.make("node-quota-reserve-dispatch");
      const runProviderInstanceId = ProviderInstanceId.make("provider-quota-reserve-failed-run");
      const currentProjection = projection({
        runs: [
          {
            id: runId,
            status: "failed",
            rootNodeId,
            providerInstanceId: runProviderInstanceId,
          } as unknown as OrchestrationV2ThreadProjection["runs"][number],
        ],
        turnItems: [
          {
            id: "turn-item-quota-reserve-dispatch",
            type: "error",
            status: "failed",
            runId,
            nodeId: rootNodeId,
            ordinal: 1,
            updatedAt: DateTime.makeUnsafe("2026-10-06T10:00:00.000Z"),
            failure: {
              class: "usage_limit",
              code: "quota_reserve",
              message: "Quota reserve reached.",
              retryable: false,
              resetAt: "2026-10-06T12:00:00.000Z",
            },
          } as unknown as OrchestrationV2ThreadProjection["turnItems"][number],
        ],
      });
      const command = messageCommand({ manualContinuationOfRunId: runId });

      yield* runWithTestServices(
        (service) => service.dispatch(command),
        testLayer({ currentProjection, dispatched, authorized, reserveEnabled: true }),
      );

      assert.deepEqual(yield* Ref.get(authorized), [
        { threadId, instanceId: runProviderInstanceId, untilIso: "2026-10-06T12:00:00.000Z" },
      ]);
      assert.deepEqual(yield* Ref.get(dispatched), [command]);
    }),
  );
});
