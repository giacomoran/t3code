import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import { QuotaReserve } from "./QuotaReserve.ts";

const makeSweep = Effect.gen(function* () {
  const quotaReserve = yield* QuotaReserve;
  return Effect.fn("QuotaReserveMonitor.sweep")(function* (instanceId?: ProviderInstanceId) {
    const activeTurns = yield* quotaReserve.activeTurns(instanceId);
    yield* Effect.forEach(
      activeTurns,
      (turn) =>
        quotaReserve.evaluate(turn.instanceId, turn.threadId).pipe(
          Effect.flatMap((decision) =>
            decision.type === "block"
              ? quotaReserve.flagReserveStop(turn.trackingId, decision.failure)
              : // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                Effect.succeed(undefined),
          ),
          Effect.flatMap((interrupt) =>
            interrupt === undefined
              ? Effect.void
              : interrupt.pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.interrupt
                      : Effect.gen(function* () {
                          // An interrupt that fails almost always means the turn is gone;
                          // retrying it every tick would only repeat the failure.
                          yield* quotaReserve.finishTurn(turn.instanceId, turn.providerTurnId);
                          yield* Effect.logWarning(
                            "Quota reserve failed to interrupt provider turn",
                            {
                              instanceId: turn.instanceId,
                              threadId: turn.threadId,
                              providerTurnId: turn.providerTurnId,
                              cause,
                            },
                          );
                        }),
                  ),
                ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const scheduler = yield* Scheduler.Scheduler;
    const sweep = yield* makeSweep;
    const watched = new Map<
      ProviderInstanceId,
      { readonly instance: ProviderInstance; readonly fiber: Fiber.Fiber<void, never> }
    >();

    const reconcile = Effect.fn("QuotaReserveMonitor.reconcile")(function* () {
      const current = yield* instances.listInstances;
      const currentById = new Map(current.map((instance) => [instance.instanceId, instance]));
      for (const [instanceId, existing] of watched) {
        if (currentById.get(instanceId) === existing.instance) continue;
        yield* Fiber.interrupt(existing.fiber);
        watched.delete(instanceId);
      }
      for (const instance of current) {
        if (watched.has(instance.instanceId)) continue;
        const fiber = yield* instance.snapshot.streamChanges.pipe(
          Stream.runForEach(() => sweep(instance.instanceId)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Quota reserve provider usage stream ended", {
                  instanceId: instance.instanceId,
                  cause,
                }),
          ),
          Effect.forkScoped,
        );
        watched.set(instance.instanceId, { instance, fiber });
      }
      yield* sweep();
    });

    const changes = yield* instances.subscribeChanges;
    yield* reconcile();
    yield* PubSub.take(changes).pipe(
      Effect.andThen(reconcile()),
      Effect.forever,
      Effect.forkScoped,
    );
    yield* scheduler.register("quota-reserve", sweep());
  }),
);
