import {
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/** Loads a thread of this environment, or null when no such thread exists. */
export type LoadSnoozeDependency<E> = (
  threadId: ThreadId,
) => Effect.Effect<OrchestrationV2AppThread | null, E>;

export const loadSnoozeDependency = (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThread">,
  threadId: ThreadId,
) =>
  projectionStore
    .getThread(threadId)
    .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));

/** A settled, archived, deleted, or missing thread no longer holds a snooze that waits on it. */
export function isSnoozeDependencyDone(thread: OrchestrationV2AppThread | null): boolean {
  return (
    thread === null ||
    thread.settledOverride === "settled" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null
  );
}

/** Whether this environment keeps a link to `environmentId`, read here without asking the peer. */
export const isEnvironmentLinked = (sql: SqlClient.SqlClient, environmentId: EnvironmentId) =>
  sql<{ readonly found: number }>`
    SELECT 1 AS found FROM peer_environment_links WHERE environment_id = ${environmentId}
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.map((rows) => rows.length > 0),
  );

export interface SnoozeWaitingDependencies {
  readonly threadIds: ReadonlyArray<ThreadId>;
  /** Threads in linked environments, which only a read through the link can check. */
  readonly linkedThreads: ReadonlyArray<ScopedThreadRef>;
}

/** The threads a still-running snooze waits on; null for a time snooze or an ended snooze. */
export function snoozeWaitingDependencies(
  thread: OrchestrationV2AppThread,
  nowMs: number,
): SnoozeWaitingDependencies | null {
  const threadIds = thread.snoozeUntilSettledThreadIds ?? [];
  const linkedThreads = thread.snoozeUntilSettledLinkedThreads ?? [];
  if (threadIds.length === 0 && linkedThreads.length === 0) return null;
  if (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs) {
    return null;
  }
  return { threadIds, linkedThreads };
}

/** Whether every thread a snooze waits on is done, read from current state. */
export const areSnoozeDependenciesDone = Effect.fn("snoozeUntilSettled.areDependenciesDone")(
  function* <E>(threadIds: ReadonlyArray<ThreadId>, loadThread: LoadSnoozeDependency<E>) {
    const dependencies = yield* Effect.forEach(threadIds, loadThread);
    return dependencies.every(isSnoozeDependencyDone);
  },
);

export type SnoozeUntilSettledValidation =
  | ({ readonly type: "valid" } & SnoozeWaitingDependencies)
  | { readonly type: "invalid"; readonly cause: string };

// Clients send now plus the cap from their own clock, which may run a little ahead.
const SNOOZE_UNTIL_SETTLED_CAP_SKEW_MS = 60 * 60 * 1000;

/**
 * Dedupes the threads a snooze will wait on and rejects lists that could never wake it early:
 * itself, unknown threads, only finished threads, or a thread already waiting on this one.
 * Linked threads need only a stored link: reading them would wait on the peer. The wake time
 * is the cap, so it may be at most 30 days out.
 */
export const validateSnoozeUntilSettledDependencies = Effect.fn("snoozeUntilSettled.validate")(
  function* <E, ELink>(input: {
    readonly threadId: ThreadId;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly linkedThreads: ReadonlyArray<ScopedThreadRef>;
    readonly snoozedUntilMs: number;
    readonly nowMs: number;
    readonly loadThread: LoadSnoozeDependency<E>;
    readonly isEnvironmentLinked: (environmentId: EnvironmentId) => Effect.Effect<boolean, ELink>;
  }) {
    const invalid = (cause: string): SnoozeUntilSettledValidation => ({ type: "invalid", cause });
    if (
      input.snoozedUntilMs >
      input.nowMs + THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS + SNOOZE_UNTIL_SETTLED_CAP_SKEW_MS
    ) {
      return invalid("A snooze until threads settle wakes at most 30 days out.");
    }
    const threadIds = [...new Set(input.threadIds)];
    if (threadIds.includes(input.threadId)) {
      return invalid(`Thread ${input.threadId} cannot wait on itself to settle.`);
    }
    const linkedThreads = [
      ...new Map(
        input.linkedThreads.map((ref) => [`${ref.environmentId}:${ref.threadId}`, ref] as const),
      ).values(),
    ];
    if (threadIds.length + linkedThreads.length > THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS) {
      return invalid(
        `A snooze until threads settle waits on at most ${THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS} threads.`,
      );
    }

    // A linked thread is reached through this environment's link to its environment.
    for (const environmentId of new Set(linkedThreads.map((ref) => ref.environmentId))) {
      if (!(yield* input.isEnvironmentLinked(environmentId))) {
        return invalid(`Environment ${environmentId} is not linked from this environment.`);
      }
    }

    // Every listed thread must exist here, and at least one must still be open. Linked
    // threads count as open: only the worker reads them.
    const dependencies = yield* Effect.forEach(threadIds, input.loadThread);
    const unknownIndex = dependencies.findIndex((dependency) => dependency === null);
    if (unknownIndex !== -1) {
      return invalid(`Thread ${threadIds[unknownIndex]} does not exist.`);
    }
    if (linkedThreads.length === 0 && dependencies.every(isSnoozeDependencyDone)) {
      return invalid("Every listed thread is already settled, archived, or deleted.");
    }

    // Walk the snoozes the listed threads wait on, directly or transitively, looking for this thread.
    const visited = new Set<ThreadId>();
    let frontier = dependencies.filter((dependency) => dependency !== null);
    while (frontier.length > 0) {
      const nextThreadIds: Array<ThreadId> = [];
      for (const dependency of frontier) {
        if (visited.has(dependency.id)) continue;
        visited.add(dependency.id);
        const waitingThreadIds =
          snoozeWaitingDependencies(dependency, input.nowMs)?.threadIds ?? [];
        if (waitingThreadIds.includes(input.threadId)) {
          return invalid(
            `Thread ${dependency.id} already waits on thread ${input.threadId} to settle.`,
          );
        }
        nextThreadIds.push(...waitingThreadIds.filter((threadId) => !visited.has(threadId)));
      }
      frontier = (yield* Effect.forEach(nextThreadIds, input.loadThread)).filter(
        (dependency) => dependency !== null,
      );
    }
    return { type: "valid", threadIds, linkedThreads } satisfies SnoozeUntilSettledValidation;
  },
);
