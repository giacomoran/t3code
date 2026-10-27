import type { ProviderThreadId, ProviderTurnId, RunAttemptId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2SessionRuntime,
  ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as QuotaReserve from "./QuotaReserve.ts";
import { startingTurnKey } from "./QuotaReserve.ts";

const decorateRuntime = Effect.fn("QuotaReserveAdapterRegistry.decorateRuntime")(function* (
  runtime: ProviderAdapterV2SessionRuntime,
  quotaReserve: QuotaReserve.QuotaReserveShape,
) {
  // Keep the input only until the provider identifies the native turn. The
  // provider thread is required to construct the adapter's interrupt call.
  const startingTurns = yield* Ref.make(new Map<string, ProviderAdapterV2TurnInput>());
  const activatedTurns = yield* Ref.make(new Set<ProviderTurnId>());

  // A session can end without a terminal for its running turn (crash, stream
  // failure); without this the monitor would keep interrupting a dead runtime.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      for (const providerTurnId of yield* Ref.get(activatedTurns)) {
        yield* quotaReserve.finishTurn(runtime.instanceId, providerTurnId);
      }
      for (const turn of (yield* Ref.get(startingTurns)).values()) {
        yield* quotaReserve.clearStartingTurn(runtime.instanceId, turn.attemptId);
      }
    }),
  );

  const deleteLocalStartingTurn = (attemptId: RunAttemptId) =>
    Ref.update(startingTurns, (current) => {
      const next = new Map(current);
      next.delete(startingTurnKey(runtime.instanceId, attemptId));
      return next;
    });

  const clearStartingTurn = (attemptId: RunAttemptId) =>
    Effect.all(
      [
        deleteLocalStartingTurn(attemptId),
        quotaReserve.clearStartingTurn(runtime.instanceId, attemptId),
      ],
      { discard: true },
    );

  const clearUnactivatedStartingTurns = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
    Ref.modify(startingTurns, (current) => {
      const attempts: Array<RunAttemptId> = [];
      const next = new Map(current);
      for (const [key, turn] of current) {
        if (turn.providerThread.id !== providerThreadId || turn.runOrdinal !== runOrdinal) continue;
        attempts.push(turn.attemptId);
        next.delete(key);
      }
      return [attempts, next] as const;
    }).pipe(
      Effect.flatMap((attempts) =>
        Effect.forEach(
          attempts,
          (attemptId) => quotaReserve.clearStartingTurn(runtime.instanceId, attemptId),
          { discard: true },
        ),
      ),
    );

  const registerStartingTurn = (input: ProviderAdapterV2TurnInput) =>
    Effect.all(
      [
        Ref.update(startingTurns, (current) =>
          new Map(current).set(startingTurnKey(runtime.instanceId, input.attemptId), input),
        ),
        quotaReserve.registerStartingTurn({
          instanceId: runtime.instanceId,
          threadId: input.threadId,
          attemptId: input.attemptId,
          providerThread: input.providerThread,
          baseItemOrdinal: input.providerTurnOrdinal * 100,
        }),
      ],
      { discard: true },
    );

  const startTrackedTurn = (
    input: ProviderAdapterV2TurnInput,
    start: (
      input: ProviderAdapterV2TurnInput,
    ) => ReturnType<ProviderAdapterV2SessionRuntime["startTurn"]>,
  ) =>
    registerStartingTurn(input).pipe(
      Effect.andThen(start(input)),
      Effect.onError(() => clearStartingTurn(input.attemptId)),
    );

  const transformEvent = Effect.fn("QuotaReserveAdapterRegistry.transformEvent")(function* (
    event: ProviderAdapterV2Event,
  ) {
    if (event.type === "provider_turn.updated" && event.providerTurn.runAttemptId !== null) {
      const attemptId = event.providerTurn.runAttemptId;
      const turn = (yield* Ref.get(startingTurns)).get(
        startingTurnKey(runtime.instanceId, attemptId),
      );
      if (turn !== undefined && turn.providerThread.id === event.providerTurn.providerThreadId) {
        yield* Ref.update(activatedTurns, (current) => new Set(current).add(event.providerTurn.id));
        yield* quotaReserve.activateTurn({
          instanceId: runtime.instanceId,
          attemptId,
          providerTurnId: event.providerTurn.id,
          interrupt: runtime.interruptTurn({
            providerThread: turn.providerThread,
            providerTurnId: event.providerTurn.id,
          }),
        });
        yield* deleteLocalStartingTurn(attemptId);
      }
      return event;
    }

    if (event.type === "turn_item.updated" && event.turnItem.providerTurnId !== null) {
      yield* quotaReserve.observeTurnItem(
        runtime.instanceId,
        event.turnItem.providerTurnId,
        event.turnItem.ordinal,
      );
      return event;
    }

    if (event.type !== "turn.terminal") return event;

    yield* clearUnactivatedStartingTurns(event.providerThreadId, event.runOrdinal);
    yield* Ref.update(activatedTurns, (current) => {
      const next = new Set(current);
      next.delete(event.providerTurnId);
      return next;
    });
    const tracked = yield* quotaReserve.finishTurn(runtime.instanceId, event.providerTurnId);
    if (event.status === "interrupted" && tracked !== undefined && tracked.failure !== undefined) {
      return {
        ...event,
        status: "failed" as const,
        failure: tracked.failure,
        failureItemOrdinal: tracked.failureItemOrdinal,
        threadDisposition: "reusable" as const,
      };
    }
    return event;
  });

  const decorateEvents = (events: ProviderAdapterV2SessionRuntime["events"]) =>
    events.pipe(Stream.mapEffect(transformEvent));
  const compactThread = runtime.compactThread;

  return {
    ...runtime,
    events: decorateEvents(runtime.events),
    ...(runtime.subscribeEvents === undefined
      ? {}
      : {
          subscribeEvents: runtime.subscribeEvents.pipe(
            Effect.map((subscription) => ({
              ...subscription,
              events: decorateEvents(subscription.events),
            })),
          ),
        }),
    startTurn: (input) => startTrackedTurn(input, runtime.startTurn),
    ...(compactThread === undefined
      ? {}
      : {
          compactThread: (input: ProviderAdapterV2TurnInput) =>
            startTrackedTurn(input, compactThread),
        }),
  } satisfies ProviderAdapterV2SessionRuntime;
});

export const layer: Layer.Layer<
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  never,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const quotaReserve = yield* QuotaReserve.QuotaReserve;
    return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: Effect.fn("ProviderAdapterRegistry.ProviderAdapterRegistryV2.get")((instanceId) =>
        registry.get(instanceId).pipe(
          Effect.map((adapter) => ({
            ...adapter,
            openSession: (input) =>
              adapter
                .openSession(input)
                .pipe(Effect.flatMap((runtime) => decorateRuntime(runtime, quotaReserve))),
          })),
        ),
      ),
      list: registry.list,
      ...(registry.getMetadata === undefined ? {} : { getMetadata: registry.getMetadata }),
    });
  }),
);
