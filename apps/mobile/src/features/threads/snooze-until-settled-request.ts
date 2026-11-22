import {
  snoozeUntilSettledLists,
  type SnoozeUntilSettledLists,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface SnoozeUntilSettledRequest {
  readonly environmentId: EnvironmentId;
  /** The threads being snoozed; they cannot wait on themselves. */
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
}

export interface SnoozeUntilSettledChoice {
  /** The picked threads, split into this environment's and linked ones. */
  readonly untilSettled: SnoozeUntilSettledLists;
  /** The 30-day cap, counted from the confirm. */
  readonly snoozedUntil: string;
}

interface PendingSnoozeUntilSettledRequest extends SnoozeUntilSettledRequest {
  readonly id: number;
  readonly resolve: (choice: SnoozeUntilSettledChoice | null) => void;
}

// The picker is mounted once at the app root, so recycled thread rows cannot unmount it.
export const snoozeUntilSettledRequestAtom = Atom.make<PendingSnoozeUntilSettledRequest | null>(
  null,
).pipe(Atom.keepAlive);

let nextRequestId = 0;

/** Opens the picker; resolves with the picked threads, or null when the user cancels. */
export function requestSnoozeUntilSettled(
  request: SnoozeUntilSettledRequest,
): Promise<SnoozeUntilSettledChoice | null> {
  appAtomRegistry.get(snoozeUntilSettledRequestAtom)?.resolve(null);
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve) => {
    appAtomRegistry.set(snoozeUntilSettledRequestAtom, { ...request, id, resolve });
  });
}

export function finishSnoozeUntilSettledRequest(
  id: number,
  picks: ReadonlyArray<ScopedThreadRef> | null,
) {
  const pending = appAtomRegistry.get(snoozeUntilSettledRequestAtom);
  if (pending?.id !== id) return;
  appAtomRegistry.set(snoozeUntilSettledRequestAtom, null);
  pending.resolve(
    picks === null
      ? null
      : {
          untilSettled: snoozeUntilSettledLists(pending.environmentId, picks),
          snoozedUntil: new Date(Date.now() + THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS).toISOString(),
        },
  );
}
