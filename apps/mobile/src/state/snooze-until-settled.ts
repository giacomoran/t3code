import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  snoozeUntilSettledDependencies,
  type SnoozeDependency,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells, threadEnvironment } from "./threads";

type SettleState = Pick<EnvironmentThreadShell, "settledOverride" | "settledAt" | "archivedAt">;
type WaitingShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "snoozeUntilSettledThreadIds" | "snoozeUntilSettledLinkedThreads"
>;

/** Settle state by `environmentId:threadId`; a key is absent when no shell is held. */
type SettleStates = ReadonlyMap<string, SettleState | "unknown-environment">;

const NO_THREADS: SettleStates = new Map();
const NO_THREADS_ATOM = Atom.make(NO_THREADS);

const keyOf = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

// Keeps its identity while the threads' settle state holds, so their streaming does not re-render.
const settleStatesAtom = Atom.family((key: string) => {
  const dependencies = JSON.parse(key) as ReadonlyArray<ScopedThreadRef>;
  let previous: SettleStates = NO_THREADS;
  return Atom.make((get) => {
    const next = new Map<string, SettleState | "unknown-environment">();
    for (const ref of dependencies) {
      // A linked thread whose environment this device has no threads from is never done.
      if (get(threadEnvironment.snapshotAtom(ref.environmentId)) === null) {
        next.set(keyOf(ref), "unknown-environment");
        continue;
      }
      const shell = get(environmentThreadShells.threadShellAtom(ref));
      if (shell === null) continue;
      next.set(keyOf(ref), {
        settledOverride: shell.settledOverride,
        settledAt: shell.settledAt,
        archivedAt: shell.archivedAt,
      });
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([threadKey, state]) => {
        const prior = previous.get(threadKey);
        if (prior === undefined) return false;
        if (state === "unknown-environment" || prior === "unknown-environment") {
          return state === prior;
        }
        return (
          prior.settledOverride === state.settledOverride &&
          prior.settledAt === state.settledAt &&
          prior.archivedAt === state.archivedAt
        );
      });
    if (unchanged) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`snooze-until-settled-states:${key}`));
});

/**
 * Settle state of the threads a snooze waits on, here and in linked environments, as
 * `presentThreadSnoozeUntilSettled` reads it. A thread the client does not hold is absent, which
 * counts as settled, unless the client has no threads from its environment at all.
 */
export function useSnoozeUntilSettledStates(
  thread: WaitingShell,
): (ref: ScopedThreadRef) => SnoozeDependency {
  const dependencies = snoozeUntilSettledDependencies(thread);
  const states = useAtomValue(
    dependencies.length === 0 ? NO_THREADS_ATOM : settleStatesAtom(JSON.stringify(dependencies)),
  );
  return (ref) => states.get(keyOf(ref));
}
