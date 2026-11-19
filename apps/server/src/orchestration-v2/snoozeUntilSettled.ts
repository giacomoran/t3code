import {
  THREAD_SNOOZE_UNTIL_SETTLED_CAP_MS,
  type OrchestrationV2AppThread,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

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

/** The threads a still-running snooze waits on; null for a time snooze or an ended snooze. */
export function snoozeWaitingThreadIds(
  thread: OrchestrationV2AppThread,
  nowMs: number,
): ReadonlyArray<ThreadId> | null {
  const threadIds = thread.snoozeUntilSettledThreadIds;
  if (threadIds == null || threadIds.length === 0) return null;
  if (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs) {
    return null;
  }
  return threadIds;
}

/** Whether every thread a snooze waits on is done, read from current state. */
export const areSnoozeDependenciesDone = Effect.fn("snoozeUntilSettled.areDependenciesDone")(
  function* <E>(threadIds: ReadonlyArray<ThreadId>, loadThread: LoadSnoozeDependency<E>) {
    const dependencies = yield* Effect.forEach(threadIds, loadThread);
    return dependencies.every(isSnoozeDependencyDone);
  },
);

export type SnoozeUntilSettledValidation =
  | { readonly type: "valid"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly type: "invalid"; readonly cause: string };

// Clients send now plus the cap from their own clock, which may run a little ahead.
const SNOOZE_UNTIL_SETTLED_CAP_SKEW_MS = 60 * 60 * 1000;

/**
 * Dedupes the threads a snooze will wait on and rejects lists that could never wake it early:
 * itself, unknown threads, only finished threads, or a thread already waiting on this one.
 * The wake time is the cap, so it may be at most 30 days out.
 */
export const validateSnoozeUntilSettledThreadIds = Effect.fn("snoozeUntilSettled.validate")(
  function* <E>(input: {
    readonly threadId: ThreadId;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly snoozedUntilMs: number;
    readonly nowMs: number;
    readonly loadThread: LoadSnoozeDependency<E>;
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

    // Every listed thread must exist here, and at least one must still be open.
    const dependencies = yield* Effect.forEach(threadIds, input.loadThread);
    const unknownIndex = dependencies.findIndex((dependency) => dependency === null);
    if (unknownIndex !== -1) {
      return invalid(`Thread ${threadIds[unknownIndex]} does not exist.`);
    }
    if (dependencies.every(isSnoozeDependencyDone)) {
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
        const waitingThreadIds = snoozeWaitingThreadIds(dependency, input.nowMs) ?? [];
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
    return { type: "valid", threadIds } satisfies SnoozeUntilSettledValidation;
  },
);
