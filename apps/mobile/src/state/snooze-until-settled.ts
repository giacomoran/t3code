import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "./threads";

type SettleState = Pick<EnvironmentThreadShell, "settledOverride" | "settledAt" | "archivedAt">;

const NO_THREADS: ReadonlyMap<ThreadId, SettleState> = new Map();
const NO_THREADS_ATOM = Atom.make(NO_THREADS);

// Keeps its identity while the threads' settle state holds, so their streaming does not re-render.
const settleStatesAtom = Atom.family((key: string) => {
  const [environmentId, threadIds] = JSON.parse(key) as [EnvironmentId, ReadonlyArray<ThreadId>];
  let previous: ReadonlyMap<ThreadId, SettleState> = NO_THREADS;
  return Atom.make((get) => {
    const next = new Map<ThreadId, SettleState>();
    for (const threadId of threadIds) {
      const shell = get(environmentThreadShells.threadShellAtom({ environmentId, threadId }));
      if (shell === null) continue;
      next.set(threadId, {
        settledOverride: shell.settledOverride,
        settledAt: shell.settledAt,
        archivedAt: shell.archivedAt,
      });
    }
    const unchanged =
      next.size === previous.size &&
      [...next].every(([threadId, state]) => {
        const prior = previous.get(threadId);
        return (
          prior !== undefined &&
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
 * Settle state of the threads a snooze waits on, for `presentThreadSnoozeUntilSettled`. A
 * thread the client does not hold is absent, which that helper counts as settled.
 */
export function useSnoozeUntilSettledStates(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId> | null | undefined,
): ReadonlyMap<ThreadId, SettleState> {
  return useAtomValue(
    threadIds == null || threadIds.length === 0
      ? NO_THREADS_ATOM
      : settleStatesAtom(JSON.stringify([environmentId, threadIds])),
  );
}
