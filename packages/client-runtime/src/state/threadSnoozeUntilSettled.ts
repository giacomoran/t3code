import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./threadSearch.ts";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";
import { toSortableTimestamp } from "./threadSort.ts";

/** "until 1 thread settles", "until 3 threads settle": completes "Snoozed …" or "Snooze …". */
export function snoozeUntilSettledPhrase(count: number): string {
  return count === 1 ? "until 1 thread settles" : `until ${count} threads settle`;
}

export interface ThreadSnoozeUntilSettledPresentation {
  /** The threads the snooze waits on; empty for a time snooze. */
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** "until 2 threads settle" while the thread is snoozed waiting on them; shown instead of the wake time. */
  readonly waitingPhrase: string | null;
  /** "Threads settled" when the thread woke because they all settled. */
  readonly wokeLabel: string | null;
}

type SnoozeDependencyShell = Pick<
  EnvironmentThreadShell,
  "settledOverride" | "settledAt" | "archivedAt"
>;

/**
 * Whether a thread a snooze waits on no longer holds it: settled or archived. Pass the client's
 * shell for the id: deleted threads have none, and archived or older settled ones may have none
 * loaded, so a missing shell counts as done, as on the server.
 */
export function isSnoozeDependencyDone(thread: SnoozeDependencyShell | undefined): boolean {
  return thread === undefined || thread.settledOverride === "settled" || thread.archivedAt !== null;
}

// Done by the wake: the server's wake sets `snoozedUntil` to when the last thread finished, so a
// thread that finished only after a cap wake does not explain it.
function isSnoozeDependencyDoneBy(
  thread: SnoozeDependencyShell | undefined,
  atMs: number,
): boolean {
  if (thread === undefined) return true;
  const finishedAt = [
    thread.settledOverride === "settled" ? thread.settledAt : null,
    thread.archivedAt,
  ].flatMap((at) => (at === null ? [] : [Date.parse(at)]));
  return finishedAt.some((ms) => ms <= atMs);
}

/**
 * How a thread's "until threads settle" snooze reads; `threadById` gives the client's shell for
 * a listed id (see `isSnoozeDependencyDone`). A wake on a request or failure, or at the 30-day
 * cap, gets no woke label.
 */
export function presentThreadSnoozeUntilSettled(
  shell: ThreadSnoozeShell & Pick<EnvironmentThreadShell, "snoozeUntilSettledThreadIds">,
  options: {
    readonly now: string;
    readonly threadById: (threadId: ThreadId) => SnoozeDependencyShell | undefined;
  },
): ThreadSnoozeUntilSettledPresentation {
  const threadIds = shell.snoozeUntilSettledThreadIds ?? [];
  if (threadIds.length === 0) return { threadIds, waitingPhrase: null, wokeLabel: null };
  if (effectiveSnoozed(shell, options)) {
    return {
      threadIds,
      waitingPhrase: snoozeUntilSettledPhrase(threadIds.length),
      wokeLabel: null,
    };
  }

  // Woke: only an expired snooze whose threads had all finished by then woke because of them.
  const snoozedUntil = shell.snoozedUntil;
  if (
    snoozedUntil == null ||
    threadWokeAt(shell, options) === null ||
    threadRaisedHandWhileSnoozed(shell)
  ) {
    return { threadIds, waitingPhrase: null, wokeLabel: null };
  }
  const wakeAtMs = Date.parse(snoozedUntil);
  const wokeOnThreadsSettled = threadIds.every((threadId) =>
    isSnoozeDependencyDoneBy(options.threadById(threadId), wakeAtMs),
  );
  return {
    threadIds,
    waitingPhrase: null,
    wokeLabel: wokeOnThreadsSettled ? "Threads settled" : null,
  };
}

/** Picks or unpicks a thread in the picker; a pick past the server's limit is left out. */
export function toggleSnoozeUntilSettledSelection(
  selectedThreadIds: ReadonlyArray<ThreadId>,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  if (selectedThreadIds.includes(threadId)) {
    return selectedThreadIds.filter((candidate) => candidate !== threadId);
  }
  if (selectedThreadIds.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS) return selectedThreadIds;
  return [...selectedThreadIds, threadId];
}

/** Shown once the picks reach the limit. */
export const SNOOZE_UNTIL_SETTLED_LIMIT_HINT = `A snooze can wait on up to ${THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS} threads.`;

/** The picker's status filter groups the row status the sidebar and thread list already show. */
export type SnoozeCandidateStatus = "working" | "attention" | "idle";
export type SnoozeCandidateStatusFilter = "all" | SnoozeCandidateStatus;

/** Web's `SidebarThreadStatus` and mobile's `ThreadListV2Status` share these values. */
export type ThreadRowStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function snoozeCandidateStatus(rowStatus: ThreadRowStatus): SnoozeCandidateStatus {
  switch (rowStatus) {
    case "preparing":
    case "working":
    case "waiting":
      return "working";
    case "approval":
    case "input":
    case "request":
    case "failed":
    case "limited":
      return "attention";
    case "ready":
      return "idle";
  }
}

export type SnoozeCandidateThread = ThreadSearchShell &
  Pick<
    EnvironmentThreadShell,
    "projectId" | "archivedAt" | "settledOverride" | "snoozedUntil" | "snoozeUntilSettledThreadIds"
  >;

export interface SnoozeUntilSettledCandidatesInput<T extends SnoozeCandidateThread> {
  /** The thread shells the client has; only `environmentId`'s are candidates. */
  readonly threads: ReadonlyArray<T>;
  readonly environmentId: EnvironmentId;
  /** The threads being snoozed. */
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
  readonly selectedThreadIds: ReadonlyArray<ThreadId>;
  /** Matched against title and project name, like the sidebar filter. */
  readonly query: string;
  /** Threads whose messages match `query`, from the thread search; they match too. */
  readonly messageMatchThreadIds?: ReadonlySet<ThreadId>;
  /** null for every project. */
  readonly projectId: ProjectId | null;
  readonly status: SnoozeCandidateStatusFilter;
  /** Map the surface's row status with `snoozeCandidateStatus`. */
  readonly statusOf: (thread: T) => SnoozeCandidateStatus;
  readonly projectTitleOf: (thread: T) => string | null;
  readonly now: string;
}

/**
 * The threads "Snooze until threads settle" can wait on, filtered and in display order: open
 * (not settled or archived) threads of the environment other than the snoozed ones and the ones
 * already waiting on them (the server rejects that cycle), matching the query, project, and status. Selected matches come first, then working threads, then the
 * most recently updated.
 */
export function resolveSnoozeUntilSettledCandidates<T extends SnoozeCandidateThread>(
  input: SnoozeUntilSettledCandidatesInput<T>,
): T[] {
  const excluded = waitingOnThreads(input);
  const selected = new Set(input.selectedThreadIds);
  const query = foldSearchQuery(input.query);

  // Only whether a thread matches counts here, so the score's clock does not matter.
  const matchesQuery = (thread: T) =>
    query === "" ||
    input.messageMatchThreadIds?.has(thread.id) === true ||
    scoreThreadSearch(query, threadSearchSubject(thread, input.projectTitleOf(thread)), 0, {
      picks: false,
    }) !== null;

  const candidates = input.threads.filter(
    (thread) =>
      thread.environmentId === input.environmentId &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      !excluded.has(thread.id) &&
      (input.projectId === null || thread.projectId === input.projectId) &&
      (input.status === "all" || input.statusOf(thread) === input.status) &&
      matchesQuery(thread),
  );

  // Rank once per thread rather than on every comparison.
  const rankOf = new Map(
    candidates.map((thread) => [
      thread,
      {
        selected: selected.has(thread.id) ? 0 : 1,
        working: input.statusOf(thread) === "working" ? 0 : 1,
        updatedAt: toSortableTimestamp(thread.updatedAt) ?? 0,
      },
    ]),
  );
  return candidates.sort((left, right) => {
    const leftRank = rankOf.get(left)!;
    const rightRank = rankOf.get(right)!;
    return (
      leftRank.selected - rightRank.selected ||
      leftRank.working - rightRank.working ||
      rightRank.updatedAt - leftRank.updatedAt
    );
  });
}

/**
 * The snoozed threads plus every thread whose running snooze waits on one of them, directly or
 * through other waiting threads: picking any of those would make a cycle.
 */
function waitingOnThreads<T extends SnoozeCandidateThread>(
  input: SnoozeUntilSettledCandidatesInput<T>,
): Set<ThreadId> {
  const nowMs = Date.parse(input.now);
  const waiting = input.threads.flatMap((thread) =>
    thread.environmentId === input.environmentId &&
    thread.snoozeUntilSettledThreadIds != null &&
    thread.snoozedUntil != null &&
    Date.parse(thread.snoozedUntil) > nowMs
      ? [{ id: thread.id, waitsOn: thread.snoozeUntilSettledThreadIds }]
      : [],
  );

  // Grow the set until no further waiting thread points into it.
  const excluded = new Set(input.excludeThreadIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const thread of waiting) {
      if (excluded.has(thread.id)) continue;
      if (!thread.waitsOn.some((threadId) => excluded.has(threadId))) continue;
      excluded.add(thread.id);
      grew = true;
    }
  }
  return excluded;
}
