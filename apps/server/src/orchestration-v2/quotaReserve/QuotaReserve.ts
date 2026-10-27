import {
  ClaudeSettings,
  CodexSettings,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type ProviderInstanceId,
  type ProviderTurnId,
  type RunAttemptId,
  type ServerProviderUsageLimits,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { ProviderAdapterV2Error } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const CLAUDE_DRIVER = "claudeAgent";
const CODEX_DRIVER = "codex";

export type QuotaReserveEvaluation =
  | { readonly type: "allow" }
  | { readonly type: "allow_unavailable" }
  | {
      readonly type: "block";
      readonly resetsAt: string;
      readonly usedPercent: number;
    };

function fiveHourWindow(limits: ServerProviderUsageLimits) {
  return limits.windows.find(
    (window) => window.id === "five_hour" || window.windowDurationMins === 300,
  );
}

export function evaluateQuotaReserve(input: {
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly percentReserve: number;
  readonly nowMs: number;
  readonly authorizedUntil: string | undefined;
}): QuotaReserveEvaluation {
  if (input.percentReserve === 0) return { type: "allow" };
  if (input.limits === undefined || input.limits.unavailable !== undefined) {
    return { type: "allow_unavailable" };
  }
  const window = fiveHourWindow(input.limits);
  if (window === undefined || window.resetsAt === undefined) {
    return { type: "allow_unavailable" };
  }
  const resetMs = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetMs) || resetMs <= input.nowMs) {
    return { type: "allow_unavailable" };
  }
  // Compare instants, not strings: probes and streamed events format the same reset differently.
  const isAuthorized =
    input.authorizedUntil !== undefined && Date.parse(input.authorizedUntil) > input.nowMs;
  if (window.usedPercent < 100 - input.percentReserve || isAuthorized) {
    return { type: "allow" };
  }
  return {
    type: "block",
    resetsAt: window.resetsAt,
    usedPercent: window.usedPercent,
  };
}

export type QuotaReserveDecision =
  | { readonly type: "allow" }
  | { readonly type: "allow_unavailable" }
  | {
      readonly type: "block";
      readonly failure: OrchestrationV2ProviderFailure;
      readonly resetsAt: string;
    };

interface QuotaReserveAuthorization {
  readonly instanceId: ProviderInstanceId;
  readonly untilIso: string;
}

export interface QuotaReserveActiveTurn {
  readonly trackingId: string;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerTurnId: ProviderTurnId;
}

interface TrackedTurn extends QuotaReserveActiveTurn {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly interrupt: Effect.Effect<void, ProviderAdapterV2Error>;
  readonly latestItemOrdinal: number;
  readonly reserveFailure: OrchestrationV2ProviderFailure | undefined;
}

interface StartingTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly attemptId: RunAttemptId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly baseItemOrdinal: number;
}

export interface QuotaReserveShape {
  readonly evaluate: (
    instanceId: ProviderInstanceId,
    threadId: ThreadId,
  ) => Effect.Effect<QuotaReserveDecision>;
  /** Authorizes until `untilIso`, or the current window's reset when omitted. */
  readonly authorize: (
    threadId: ThreadId,
    instanceId: ProviderInstanceId,
    untilIso?: string,
  ) => Effect.Effect<boolean>;
  readonly isEnabled: (instanceId: ProviderInstanceId) => Effect.Effect<boolean>;
  readonly registerStartingTurn: (turn: StartingTurn) => Effect.Effect<void>;
  readonly clearStartingTurn: (
    instanceId: ProviderInstanceId,
    attemptId: RunAttemptId,
  ) => Effect.Effect<void>;
  readonly activateTurn: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly attemptId: RunAttemptId;
    readonly providerTurnId: ProviderTurnId;
    readonly interrupt: Effect.Effect<void, ProviderAdapterV2Error>;
  }) => Effect.Effect<void>;
  readonly observeTurnItem: (
    instanceId: ProviderInstanceId,
    providerTurnId: ProviderTurnId,
    ordinal: number,
  ) => Effect.Effect<void>;
  readonly activeTurns: (
    instanceId?: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<QuotaReserveActiveTurn>>;
  readonly flagReserveStop: (
    trackingId: string,
    failure: OrchestrationV2ProviderFailure,
  ) => Effect.Effect<Effect.Effect<void, ProviderAdapterV2Error> | undefined>;
  readonly finishTurn: (
    instanceId: ProviderInstanceId,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<
    | {
        readonly failure: OrchestrationV2ProviderFailure | undefined;
        readonly failureItemOrdinal: number;
      }
    | undefined
  >;
}

const noop: QuotaReserveShape = {
  evaluate: () => Effect.succeed({ type: "allow" }),
  authorize: () => Effect.succeed(false),
  isEnabled: () => Effect.succeed(false),
  registerStartingTurn: () => Effect.void,
  clearStartingTurn: () => Effect.void,
  activateTurn: () => Effect.void,
  observeTurnItem: () => Effect.void,
  activeTurns: () => Effect.succeed([]),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  flagReserveStop: () => Effect.succeed(undefined),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  finishTurn: () => Effect.succeed(undefined),
};

export class QuotaReserve extends Context.Reference<QuotaReserveShape>(
  "t3/orchestration-v2/quotaReserve/QuotaReserve",
  { defaultValue: () => noop },
) {}

export function startingTurnKey(instanceId: ProviderInstanceId, attemptId: RunAttemptId): string {
  return `${instanceId}:${attemptId}`;
}

function activeTurnKey(instanceId: ProviderInstanceId, providerTurnId: ProviderTurnId): string {
  return `${instanceId}:${providerTurnId}`;
}

export const layer = Layer.effect(
  QuotaReserve,
  Effect.gen(function* () {
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const settings = yield* ServerSettings.ServerSettingsService;
    const authorizations = yield* Ref.make(new Map<ThreadId, QuotaReserveAuthorization>());
    const warnedUnavailable = yield* Ref.make(new Set<ProviderInstanceId>());
    const startingTurns = yield* Ref.make(new Map<string, StartingTurn>());
    const activeTurns = yield* Ref.make(new Map<string, TrackedTurn>());

    const pruneExpiredAuthorizations = (nowMs: number) =>
      Ref.update(authorizations, (current) => {
        let next: Map<ThreadId, QuotaReserveAuthorization> | undefined;
        for (const [threadId, authorization] of current) {
          if (Date.parse(authorization.untilIso) > nowMs) continue;
          next ??= new Map(current);
          next.delete(threadId);
        }
        return next ?? current;
      });

    const readReserve = Effect.fn("QuotaReserve.readReserve")(function* (
      instanceId: ProviderInstanceId,
    ) {
      const instance = yield* instances.getInstance(instanceId);
      if (instance === undefined) return null;
      if (instance.driverKind !== CLAUDE_DRIVER && instance.driverKind !== CODEX_DRIVER)
        return null;

      const currentSettings = yield* settings.getSettings;
      const entry = deriveProviderInstanceConfigMap(currentSettings)[instanceId];
      if (entry === undefined || entry.driver !== instance.driverKind) return null;
      const schema = instance.driverKind === CLAUDE_DRIVER ? ClaudeSettings : CodexSettings;
      const decoded = yield* Schema.decodeUnknownEffect(schema)(entry.config).pipe(Effect.option);
      if (Option.isNone(decoded) || decoded.value.percentQuotaReserve === "") return null;
      return {
        instance,
        percentReserve: Number(decoded.value.percentQuotaReserve),
        providerLabel: instance.driverKind === CLAUDE_DRIVER ? "Claude" : "Codex",
      } as const;
    });

    const readEvaluation = Effect.fn("QuotaReserve.readEvaluation")(function* (
      instanceId: ProviderInstanceId,
      threadId: ThreadId,
    ) {
      const reserve = yield* readReserve(instanceId);
      if (reserve === null) {
        return { evaluation: { type: "allow" } as const, reserve: null, limits: undefined };
      }
      const snapshot = yield* reserve.instance.snapshot.getSnapshot;
      const limits = snapshot.usageLimits;
      const nowMs = yield* Clock.currentTimeMillis;
      yield* pruneExpiredAuthorizations(nowMs);
      const authorization = (yield* Ref.get(authorizations)).get(threadId);
      const authorizedUntil =
        authorization?.instanceId === instanceId ? authorization.untilIso : undefined;
      const evaluation = evaluateQuotaReserve({
        limits,
        percentReserve: reserve.percentReserve,
        nowMs,
        authorizedUntil,
      });
      return { evaluation, reserve, limits };
    });

    const evaluate: QuotaReserveShape["evaluate"] = (instanceId, threadId) =>
      Effect.gen(function* () {
        const { evaluation, reserve } = yield* readEvaluation(instanceId, threadId);
        if (evaluation.type === "allow_unavailable") {
          const shouldWarn = yield* Ref.modify(warnedUnavailable, (current) => {
            if (current.has(instanceId)) return [false, current] as const;
            const next = new Set(current);
            next.add(instanceId);
            return [true, next] as const;
          });
          if (shouldWarn) {
            yield* Effect.logWarning("Quota reserve usage is unavailable; allowing work", {
              instanceId,
            });
          }
          return { type: "allow_unavailable" } as const;
        }
        const clearWarning = Ref.update(warnedUnavailable, (current) => {
          if (!current.has(instanceId)) return current;
          const next = new Set(current);
          next.delete(instanceId);
          return next;
        });
        if (evaluation.type === "allow") {
          yield* clearWarning;
          return { type: "allow" } as const;
        }
        if (reserve === null) {
          return yield* Effect.die("Blocked quota evaluation has no reserve config.");
        }
        const failure = makeProviderFailure({
          class: "usage_limit",
          code: "quota_reserve",
          retryable: false,
          resetAt: evaluation.resetsAt,
          message: `${reserve.providerLabel} paused to preserve your ${reserve.percentReserve}% quota reserve (${evaluation.usedPercent}% used). Press Continue or send /reserve to spend the reserve on this thread until reset, or wait for the reset.`,
        });
        yield* clearWarning;
        return { type: "block", failure, resetsAt: evaluation.resetsAt } as const;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Quota reserve evaluation failed; allowing work", {
                instanceId,
                cause,
              }).pipe(Effect.as({ type: "allow_unavailable" } as const)),
        ),
      );

    const authorize: QuotaReserveShape["authorize"] = (threadId, instanceId, untilIso) =>
      Effect.gen(function* () {
        const reserve = yield* readReserve(instanceId);
        if (reserve === null) return false;
        const nowMs = yield* Clock.currentTimeMillis;
        yield* pruneExpiredAuthorizations(nowMs);
        let until = untilIso;
        if (until === undefined) {
          const snapshot = yield* reserve.instance.snapshot.getSnapshot;
          const window =
            snapshot.usageLimits === undefined ? undefined : fiveHourWindow(snapshot.usageLimits);
          if (snapshot.usageLimits?.unavailable === undefined) until = window?.resetsAt;
        }
        // A reset already past means a new window: its reserve stays protected.
        if (until !== undefined && Date.parse(until) > nowMs) {
          const authorizedUntil = until;
          yield* Ref.update(authorizations, (current) =>
            new Map(current).set(threadId, { instanceId, untilIso: authorizedUntil }),
          );
        }
        return true;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Quota reserve authorization failed", { instanceId, cause }).pipe(
                Effect.as(false),
              ),
        ),
      );

    return QuotaReserve.of({
      evaluate,
      authorize,
      isEnabled: Effect.fn("QuotaReserve.isEnabled")((instanceId) =>
        readReserve(instanceId).pipe(
          Effect.map((reserve) => reserve !== null),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(false),
          ),
        ),
      ),
      registerStartingTurn: Effect.fn("QuotaReserve.registerStartingTurn")((turn) =>
        Ref.update(startingTurns, (current) =>
          new Map(current).set(startingTurnKey(turn.instanceId, turn.attemptId), turn),
        ),
      ),
      clearStartingTurn: Effect.fn("QuotaReserve.clearStartingTurn")((instanceId, attemptId) =>
        Ref.update(startingTurns, (current) => {
          const next = new Map(current);
          next.delete(startingTurnKey(instanceId, attemptId));
          return next;
        }),
      ),
      activateTurn: Effect.fn("QuotaReserve.activateTurn")((input) =>
        Ref.modify(startingTurns, (current) => {
          const key = startingTurnKey(input.instanceId, input.attemptId);
          const turn = current.get(key);
          if (turn === undefined) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(key);
          return [turn, next] as const;
        }).pipe(
          Effect.flatMap((turn) => {
            if (turn === undefined) return Effect.void;
            const trackingId = activeTurnKey(input.instanceId, input.providerTurnId);
            return Ref.update(activeTurns, (current) => {
              if (current.has(trackingId)) return current;
              return new Map(current).set(trackingId, {
                trackingId,
                instanceId: input.instanceId,
                threadId: turn.threadId,
                providerTurnId: input.providerTurnId,
                providerThread: turn.providerThread,
                interrupt: input.interrupt,
                latestItemOrdinal: turn.baseItemOrdinal,
                reserveFailure: undefined,
              });
            });
          }),
        ),
      ),
      observeTurnItem: Effect.fn("QuotaReserve.observeTurnItem")(
        (instanceId, providerTurnId, ordinal) =>
          Ref.update(activeTurns, (current) => {
            const trackingId = activeTurnKey(instanceId, providerTurnId);
            const turn = current.get(trackingId);
            if (turn === undefined || turn.latestItemOrdinal >= ordinal) return current;
            return new Map(current).set(trackingId, { ...turn, latestItemOrdinal: ordinal });
          }),
      ),
      activeTurns: Effect.fn("QuotaReserve.activeTurns")((instanceId) =>
        Ref.get(activeTurns).pipe(
          Effect.map((current) =>
            [...current.values()]
              .filter((turn) => instanceId === undefined || turn.instanceId === instanceId)
              .map(({ trackingId, instanceId, threadId, providerTurnId }) => ({
                trackingId,
                instanceId,
                threadId,
                providerTurnId,
              })),
          ),
        ),
      ),
      flagReserveStop: Effect.fn("QuotaReserve.flagReserveStop")((trackingId, failure) =>
        Ref.modify(activeTurns, (current) => {
          const turn = current.get(trackingId);
          if (turn === undefined || turn.reserveFailure !== undefined) {
            return [undefined, current] as const;
          }
          return [
            turn.interrupt,
            new Map(current).set(trackingId, { ...turn, reserveFailure: failure }),
          ] as const;
        }),
      ),
      finishTurn: Effect.fn("QuotaReserve.finishTurn")((instanceId, providerTurnId) =>
        Ref.modify(activeTurns, (current) => {
          const trackingId = activeTurnKey(instanceId, providerTurnId);
          const turn = current.get(trackingId);
          if (turn === undefined) return [undefined, current] as const;
          const next = new Map(current);
          next.delete(trackingId);
          return [
            {
              failure: turn.reserveFailure,
              failureItemOrdinal: turn.latestItemOrdinal + 1,
            },
            next,
          ] as const;
        }),
      ),
    });
  }),
);
