import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { EnvironmentThreadShell } from "./models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./threadSearch.ts";
import {
  effectiveSnoozed,
  threadRaisedHandWhileSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";
import { toSortableTimestamp } from "./threadSort.ts";

/** "Snoozed until 2 threads settle": a snooze waiting on `count` threads. */
export function snoozedUntilSettledLabel(
  count: number,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    msg(
      "Snoozed until {count, plural, one {{count} thread settles} other {{count} threads settle}}",
      { count },
    ),
  );
}

/** "Snooze until 2 threads settle": the picker's confirm button. */
export function snoozeUntilSettledActionLabel(
  count: number,
  resolve: MFunctionType = mFallback,
): string {
  return resolve(
    msg(
      "Snooze until {count, plural, one {{count} thread settles} other {{count} threads settle}}",
      { count },
    ),
  );
}

type SnoozeWaitingShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "snoozeUntilSettledThreadIds" | "snoozeUntilSettledLinkedThreads"
>;

/** The threads a snooze waits on, in its own environment first and then in linked ones. */
export function snoozeUntilSettledDependencies(
  shell: SnoozeWaitingShell,
): ReadonlyArray<ScopedThreadRef> {
  return [
    ...(shell.snoozeUntilSettledThreadIds ?? []).map((threadId) => ({
      environmentId: shell.environmentId,
      threadId,
    })),
    ...(shell.snoozeUntilSettledLinkedThreads ?? []),
  ];
}

/** The threads a snooze waits on, as `thread.snooze` takes them; both absent for a time snooze. */
export interface SnoozeUntilSettledLists {
  readonly untilSettledThreadIds?: ReadonlyArray<ThreadId>;
  readonly untilSettledLinkedThreads?: ReadonlyArray<ScopedThreadRef>;
}

/** How many threads the lists name together. */
export function snoozeUntilSettledCount(lists: SnoozeUntilSettledLists): number {
  return (
    (lists.untilSettledThreadIds?.length ?? 0) + (lists.untilSettledLinkedThreads?.length ?? 0)
  );
}

/** Splits picks into the snooze command's lists: this environment's, and linked ones. */
export function snoozeUntilSettledLists(
  environmentId: EnvironmentId,
  picks: ReadonlyArray<ScopedThreadRef>,
): SnoozeUntilSettledLists {
  const threadIds = picks
    .filter((ref) => ref.environmentId === environmentId)
    .map((ref) => ref.threadId);
  const linkedThreads = picks.filter((ref) => ref.environmentId !== environmentId);
  return {
    ...(threadIds.length === 0 ? {} : { untilSettledThreadIds: threadIds }),
    ...(linkedThreads.length === 0 ? {} : { untilSettledLinkedThreads: linkedThreads }),
  };
}

export interface ThreadSnoozeUntilSettledPresentation {
  /** The threads the snooze waits on; empty for a time snooze. */
  readonly dependencies: ReadonlyArray<ScopedThreadRef>;
  /** How many threads the snooze still waits on while snoozed; shown instead of the wake time. */
  readonly waitingCount: number | null;
  /** "Threads settled" when the thread woke because they all settled. */
  readonly wokeLabel: string | null;
}

type SnoozeDependencyShell = Pick<
  EnvironmentThreadShell,
  "settledOverride" | "settledAt" | "archivedAt"
>;

/**
 * A thread a snooze waits on as the client holds it: its shell; undefined when the client has
 * its environment's threads but no shell for it (deleted, or archived or older settled ones not
 * loaded); or "unknown-environment" when the client has no threads from its environment.
 */
export type SnoozeDependency = SnoozeDependencyShell | undefined | "unknown-environment";

/**
 * Whether a thread a snooze waits on no longer holds it: settled or archived. A missing shell
 * counts as done, as on the server; a thread in an environment the client cannot see never does.
 */
export function isSnoozeDependencyDone(thread: SnoozeDependency): boolean {
  if (thread === "unknown-environment") return false;
  return thread === undefined || thread.settledOverride === "settled" || thread.archivedAt !== null;
}

/** Looks a listed thread up in the client's shells; see `SnoozeDependency`. */
export function snoozeDependencyLookup(
  shells: ReadonlyArray<
    SnoozeDependencyShell & Pick<EnvironmentThreadShell, "id" | "environmentId">
  >,
  loadedEnvironmentIds: ReadonlySet<EnvironmentId>,
): (ref: ScopedThreadRef) => SnoozeDependency {
  const shellByKey = new Map(
    shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell] as const),
  );
  return (ref) => {
    if (!loadedEnvironmentIds.has(ref.environmentId)) return "unknown-environment";
    return shellByKey.get(`${ref.environmentId}:${ref.threadId}`);
  };
}

// Done by the wake: the server's wake sets `snoozedUntil` to when the last thread finished, so a
// thread that finished only after a cap wake does not explain it.
function isSnoozeDependencyDoneBy(thread: SnoozeDependency, atMs: number): boolean {
  if (thread === "unknown-environment") return false;
  if (thread === undefined) return true;
  const finishedAt = [
    thread.settledOverride === "settled" ? thread.settledAt : null,
    thread.archivedAt,
  ].flatMap((at) => (at === null ? [] : [Date.parse(at)]));
  return finishedAt.some((ms) => ms <= atMs);
}

/**
 * How a thread's "until threads settle" snooze reads; `dependencyOf` gives the client's view of
 * a listed thread (see `SnoozeDependency`). A wake on a request or failure, or at the 30-day
 * cap, gets no woke label.
 */
export function presentThreadSnoozeUntilSettled(
  shell: ThreadSnoozeShell & SnoozeWaitingShell,
  options: {
    readonly now: string;
    readonly dependencyOf: (ref: ScopedThreadRef) => SnoozeDependency;
    readonly resolve?: MFunctionType;
  },
): ThreadSnoozeUntilSettledPresentation {
  const dependencies = snoozeUntilSettledDependencies(shell);
  if (dependencies.length === 0) return { dependencies, waitingCount: null, wokeLabel: null };
  if (effectiveSnoozed(shell, options)) {
    return { dependencies, waitingCount: dependencies.length, wokeLabel: null };
  }

  // Woke: only an expired snooze whose threads had all finished by then woke because of them.
  const snoozedUntil = shell.snoozedUntil;
  if (
    snoozedUntil == null ||
    threadWokeAt(shell, options) === null ||
    threadRaisedHandWhileSnoozed(shell)
  ) {
    return { dependencies, waitingCount: null, wokeLabel: null };
  }
  const wakeAtMs = Date.parse(snoozedUntil);
  const wokeOnThreadsSettled = dependencies.every((ref) => {
    const dependency = options.dependencyOf(ref);
    // A linked thread with no shell here may just not be loaded, so it cannot explain the wake.
    if (dependency === undefined && ref.environmentId !== shell.environmentId) return false;
    return isSnoozeDependencyDoneBy(dependency, wakeAtMs);
  });
  return {
    dependencies,
    waitingCount: null,
    wokeLabel: wokeOnThreadsSettled
      ? (options.resolve ?? mFallback)(
          msg("Threads settled", { $context: "why a snoozed thread woke" }),
        )
      : null,
  };
}

function isSameThread(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

/** Whether `ref` is among the picks. */
export function isSnoozeUntilSettledSelected(
  selected: ReadonlyArray<ScopedThreadRef>,
  ref: ScopedThreadRef,
): boolean {
  return selected.some((candidate) => isSameThread(candidate, ref));
}

/** Picks or unpicks a thread in the picker; a pick past the server's limit is left out. */
export function toggleSnoozeUntilSettledSelection(
  selected: ReadonlyArray<ScopedThreadRef>,
  ref: ScopedThreadRef,
): ReadonlyArray<ScopedThreadRef> {
  if (isSnoozeUntilSettledSelected(selected, ref)) {
    return selected.filter((candidate) => !isSameThread(candidate, ref));
  }
  if (selected.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS) return selected;
  return [...selected, ref];
}

/** Shown once the picks reach the limit. */
export function snoozeUntilSettledLimitHint(resolve: MFunctionType = mFallback): string {
  return resolve(
    msg("A snooze can wait on up to {max} threads.", {
      max: THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
    }),
  );
}

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
  /** The thread shells the client has; only those in `environmentIds` are candidates. */
  readonly threads: ReadonlyArray<T>;
  /** The snoozed threads' environment. */
  readonly environmentId: EnvironmentId;
  /** It and the environments it links to that this client also reaches. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** The threads being snoozed, in `environmentId`. */
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
  readonly selected: ReadonlyArray<ScopedThreadRef>;
  /** Matched against title, project name, and environment label, like the sidebar filter. */
  readonly query: string;
  /** `environmentId:threadId` keys of threads whose messages match `query`; they match too. */
  readonly messageMatchThreadKeys?: ReadonlySet<string>;
  /** null for every environment. */
  readonly environmentFilter: EnvironmentId | null;
  /** null for every project. */
  readonly project: ScopedProjectRef | null;
  readonly status: SnoozeCandidateStatusFilter;
  /** Map the surface's row status with `snoozeCandidateStatus`. */
  readonly statusOf: (thread: T) => SnoozeCandidateStatus;
  readonly projectTitleOf: (thread: T) => string | null;
  readonly environmentLabelOf: (thread: T) => string | null;
  readonly now: string;
}

/**
 * The threads "Snooze until threads settle" can wait on, in display order: open threads of the
 * offered environments, minus the snoozed ones and those here already waiting on them (a cycle
 * the server rejects), matching the filters. Selected matches lead, then working threads, then
 * the most recently updated.
 */
export function resolveSnoozeUntilSettledCandidates<T extends SnoozeCandidateThread>(
  input: SnoozeUntilSettledCandidatesInput<T>,
): T[] {
  const excluded = waitingOnThreads(input);
  const environmentIds = new Set(input.environmentIds);
  const query = foldSearchQuery(input.query);
  const refOf = (thread: T) => ({ environmentId: thread.environmentId, threadId: thread.id });

  // Only whether a thread matches counts here, so the score's clock does not matter.
  const matchesQuery = (thread: T) =>
    query === "" ||
    input.messageMatchThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true ||
    scoreThreadSearch(
      query,
      threadSearchSubject(
        thread,
        input.projectTitleOf(thread),
        environmentIds.size > 1 ? input.environmentLabelOf(thread) : null,
      ),
      0,
      { picks: false },
    ) !== null;

  const candidates = input.threads.filter(
    (thread) =>
      environmentIds.has(thread.environmentId) &&
      thread.archivedAt === null &&
      thread.settledOverride !== "settled" &&
      !(thread.environmentId === input.environmentId && excluded.has(thread.id)) &&
      (input.environmentFilter === null || thread.environmentId === input.environmentFilter) &&
      (input.project === null ||
        (thread.environmentId === input.project.environmentId &&
          thread.projectId === input.project.projectId)) &&
      (input.status === "all" || input.statusOf(thread) === input.status) &&
      matchesQuery(thread),
  );

  // Rank once per thread rather than on every comparison.
  const rankOf = new Map(
    candidates.map((thread) => [
      thread,
      {
        selected: isSnoozeUntilSettledSelected(input.selected, refOf(thread)) ? 0 : 1,
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
