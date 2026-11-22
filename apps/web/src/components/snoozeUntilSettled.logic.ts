import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadSnoozeShell } from "@t3tools/client-runtime/state/thread-settled";
import {
  isSnoozeDependencyDone,
  presentThreadSnoozeUntilSettled,
  snoozeDependencyLookup,
  snoozedUntilSettledLabel,
  snoozeUntilSettledLists,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

import type { SnoozeChoice } from "./Sidebar.snooze";

/** The wait on threads still wakes at the cap, in case they never settle. */
export function snoozeUntilSettledChoice(
  environmentId: EnvironmentId,
  picks: ReadonlyArray<ScopedThreadRef>,
  now: Date,
): SnoozeChoice {
  if (picks.length === 0) throw new Error("Snoozing until threads settle needs a thread");
  return {
    snoozedUntil: new Date(now.getTime() + THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS).toISOString(),
    ...snoozeUntilSettledLists(environmentId, picks),
  };
}

type SnoozeUntilSettledKeyAction =
  | "move-up"
  | "move-down"
  | "toggle"
  | "confirm"
  | "toggle-and-confirm";

/**
 * What a key in the picker's search box does. Space types into a query unless the user is
 * moving through the list with the arrows (or there is nothing typed yet), so multi-word
 * searches still work. Enter with nothing picked takes the highlighted thread.
 */
export function resolveSnoozeUntilSettledKey(input: {
  readonly key: string;
  readonly isComposing: boolean;
  readonly query: string;
  readonly isNavigating: boolean;
  readonly hasHighlight: boolean;
  readonly selectedCount: number;
}): SnoozeUntilSettledKeyAction | null {
  if (input.isComposing) return null;
  if (input.key === "ArrowDown") return "move-down";
  if (input.key === "ArrowUp") return "move-up";
  if (input.key === " " && input.hasHighlight && (input.isNavigating || input.query === "")) {
    return "toggle";
  }
  if (input.key === "Enter" && input.selectedCount > 0) return "confirm";
  if (input.key === "Enter" && input.hasHighlight) return "toggle-and-confirm";
  return null;
}

/** The highlighted row's key: the one the user moved to while still listed, else the first. */
export function resolveHighlightedThreadKey(
  threadKeys: ReadonlyArray<string>,
  highlightedThreadKey: string | null,
): string | null {
  if (highlightedThreadKey !== null && threadKeys.includes(highlightedThreadKey)) {
    return highlightedThreadKey;
  }
  return threadKeys[0] ?? null;
}

/** Moves the highlight one row, stopping at either end of the list. */
export function moveHighlightedThreadKey(
  threadKeys: ReadonlyArray<string>,
  highlightedThreadKey: string | null,
  direction: "up" | "down",
): string | null {
  if (threadKeys.length === 0) return null;
  const index = highlightedThreadKey === null ? -1 : threadKeys.indexOf(highlightedThreadKey);
  if (index === -1) return threadKeys[0]!;
  const nextIndex =
    direction === "down" ? Math.min(index + 1, threadKeys.length - 1) : Math.max(index - 1, 0);
  return threadKeys[nextIndex]!;
}

interface SnoozeUntilSettledProjectOption {
  readonly project: ScopedProjectRef;
  readonly title: string;
}

/** The projects the picker's filter offers: those of the threads it can list, by title. */
export function snoozeUntilSettledProjectOptions<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "projectId">,
>(
  threads: ReadonlyArray<T>,
  projectTitleOf: (thread: T) => string | null,
): ReadonlyArray<SnoozeUntilSettledProjectOption> {
  const optionByKey = new Map<string, SnoozeUntilSettledProjectOption>();
  for (const thread of threads) {
    const title = projectTitleOf(thread);
    if (title === null) continue;
    optionByKey.set(`${thread.environmentId}:${thread.projectId}`, {
      project: { environmentId: thread.environmentId, projectId: thread.projectId },
      title,
    });
  }
  return [...optionByKey.values()].toSorted((left, right) => left.title.localeCompare(right.title));
}

interface SnoozeWaitingOnThread {
  readonly ref: ScopedThreadRef;
  readonly title: string;
  readonly isSettled: boolean;
  /** In a linked environment rather than the snoozed thread's own. */
  readonly isLinked: boolean;
}

export interface SnoozeUntilSettledState {
  /** How many threads the snooze waits on, loaded or not. */
  readonly threadCount: number;
  /** How many threads the snooze still waits on while snoozed. */
  readonly waitingCount: number | null;
  /** The listed threads the client has loaded, in the order they were picked. */
  readonly waitingOn: ReadonlyArray<SnoozeWaitingOnThread>;
  /** "Threads settled" when that is why the thread woke. */
  readonly wokeLabel: string | null;
}

/**
 * How a thread's wait on other threads reads, or null for a time snooze. `shells` holds what the
 * client has of the listed threads: a missing one counts as settled where its environment's
 * threads are loaded, as on the server, and as open elsewhere.
 */
export function presentSnoozeUntilSettled(
  thread: ThreadSnoozeShell &
    Pick<
      EnvironmentThreadShell,
      "environmentId" | "snoozeUntilSettledThreadIds" | "snoozeUntilSettledLinkedThreads"
    >,
  options: {
    readonly now: string;
    readonly shells: {
      readonly shells: ReadonlyArray<
        Pick<
          EnvironmentThreadShell,
          "id" | "environmentId" | "title" | "settledOverride" | "settledAt" | "archivedAt"
        >
      >;
      readonly loadedEnvironmentIds: ReadonlySet<EnvironmentId>;
    };
    readonly resolve?: MessageResolver;
  },
): SnoozeUntilSettledState | null {
  if (
    (thread.snoozeUntilSettledThreadIds ?? []).length === 0 &&
    (thread.snoozeUntilSettledLinkedThreads ?? []).length === 0
  ) {
    return null;
  }
  const shellByKey = new Map(
    options.shells.shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell] as const),
  );
  const presentation = presentThreadSnoozeUntilSettled(thread, {
    now: options.now,
    dependencyOf: snoozeDependencyLookup(
      options.shells.shells,
      options.shells.loadedEnvironmentIds,
    ),
    resolve: options.resolve ?? m,
  });
  return {
    threadCount: presentation.dependencies.length,
    waitingCount: presentation.waitingCount,
    waitingOn: presentation.dependencies.flatMap((ref) => {
      const shell = shellByKey.get(`${ref.environmentId}:${ref.threadId}`);
      if (shell === undefined) return [];
      return [
        {
          ref,
          title: shell.title,
          isSettled: isSnoozeDependencyDone(shell),
          isLinked: ref.environmentId !== thread.environmentId,
        },
      ];
    }),
    wokeLabel: presentation.wokeLabel,
  };
}

/** "Snoozed until 2 threads settle: Fix login, Refactor API" for the thread view. */
export function snoozeUntilSettledStatusLabel(
  state: Pick<SnoozeUntilSettledState, "waitingCount" | "waitingOn">,
  resolve: MessageResolver = m,
): string {
  if (state.waitingCount === null) throw new Error("The snooze is not waiting on threads");
  const titles = state.waitingOn.map((thread) => thread.title);
  return titles.length === 0
    ? snoozedUntilSettledLabel(state.waitingCount, resolve)
    : resolve(
        msg(
          "Snoozed until {count, plural, one {{count} thread settles} other {{count} threads settle}}: {titles}",
          { count: state.waitingCount, titles: titles.join(", ") },
        ),
      );
}
