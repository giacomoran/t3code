import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ThreadSnoozeShell } from "@t3tools/client-runtime/state/thread-settled";
import {
  isSnoozeDependencyDone,
  presentThreadSnoozeUntilSettled,
  snoozedUntilSettledLabel,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../i18n/messages";

import type { SnoozeChoice } from "./Sidebar.snooze";

/** The wait on threads still wakes at the cap, in case they never settle. */
export function snoozeUntilSettledChoice(
  threadIds: ReadonlyArray<ThreadId>,
  now: Date,
): SnoozeChoice {
  if (threadIds.length === 0) throw new Error("Snoozing until threads settle needs a thread");
  return {
    snoozedUntil: new Date(now.getTime() + THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS).toISOString(),
    untilSettledThreadIds: threadIds,
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

/** The highlighted row: the one the user moved to while it is still listed, else the first. */
export function resolveHighlightedThreadId(
  threadIds: ReadonlyArray<ThreadId>,
  highlightedThreadId: ThreadId | null,
): ThreadId | null {
  if (highlightedThreadId !== null && threadIds.includes(highlightedThreadId)) {
    return highlightedThreadId;
  }
  return threadIds[0] ?? null;
}

/** Moves the highlight one row, stopping at either end of the list. */
export function moveHighlightedThreadId(
  threadIds: ReadonlyArray<ThreadId>,
  highlightedThreadId: ThreadId | null,
  direction: "up" | "down",
): ThreadId | null {
  if (threadIds.length === 0) return null;
  const index = highlightedThreadId === null ? -1 : threadIds.indexOf(highlightedThreadId);
  if (index === -1) return threadIds[0]!;
  const nextIndex =
    direction === "down" ? Math.min(index + 1, threadIds.length - 1) : Math.max(index - 1, 0);
  return threadIds[nextIndex]!;
}

interface SnoozeUntilSettledProjectOption {
  readonly projectId: ProjectId;
  readonly title: string;
}

/** The projects the picker's filter offers: those of the threads it can list, by title. */
export function snoozeUntilSettledProjectOptions<
  T extends Pick<EnvironmentThreadShell, "projectId">,
>(
  threads: ReadonlyArray<T>,
  projectTitleOf: (thread: T) => string | null,
): ReadonlyArray<SnoozeUntilSettledProjectOption> {
  const titleByProjectId = new Map<ProjectId, string>();
  for (const thread of threads) {
    const title = projectTitleOf(thread);
    if (title !== null) titleByProjectId.set(thread.projectId, title);
  }
  return [...titleByProjectId]
    .map(([projectId, title]) => ({ projectId, title }))
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

interface SnoozeWaitingOnThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly isSettled: boolean;
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
 * How a thread's wait on other threads reads, or null for a time snooze. `shells` holds the
 * shells to look the listed threads up in; ones it lacks count as settled, as on the server.
 */
export function presentSnoozeUntilSettled(
  thread: ThreadSnoozeShell &
    Pick<EnvironmentThreadShell, "environmentId" | "snoozeUntilSettledThreadIds">,
  options: {
    readonly now: string;
    readonly shells: ReadonlyArray<
      Pick<
        EnvironmentThreadShell,
        "id" | "environmentId" | "title" | "settledOverride" | "settledAt" | "archivedAt"
      >
    >;
    readonly resolve?: MessageResolver;
  },
): SnoozeUntilSettledState | null {
  if ((thread.snoozeUntilSettledThreadIds ?? []).length === 0) return null;
  const shellById = new Map(
    options.shells
      .filter((shell) => shell.environmentId === thread.environmentId)
      .map((shell) => [shell.id, shell] as const),
  );
  const presentation = presentThreadSnoozeUntilSettled(thread, {
    now: options.now,
    threadById: (threadId) => shellById.get(threadId),
    resolve: options.resolve ?? m,
  });
  return {
    threadCount: presentation.threadIds.length,
    waitingCount: presentation.waitingCount,
    waitingOn: presentation.threadIds.flatMap((threadId) => {
      const shell = shellById.get(threadId);
      if (shell === undefined) return [];
      return [
        {
          threadId,
          title: shell.title,
          isSettled: isSnoozeDependencyDone(shell),
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
