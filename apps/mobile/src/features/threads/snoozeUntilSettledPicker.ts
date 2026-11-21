import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  resolveSnoozeUntilSettledCandidates,
  snoozeCandidateStatus,
  type SnoozeCandidateStatus,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import { relativeTime } from "../../lib/time";
import { resolveThreadListV2RowStatus } from "./threadListV2";

export const SNOOZE_UNTIL_SETTLED_STATUS_FILTERS = [
  { value: "all", label: msg("All", { $context: "thread status filter" }) },
  { value: "working", label: msg("Working", { $context: "thread status" }) },
  { value: "attention", label: msg("Needs attention") },
  { value: "idle", label: msg("Idle", { $context: "thread status" }) },
] as const satisfies ReadonlyArray<{
  readonly value: SnoozeCandidateStatusFilter;
  readonly label: ReturnType<typeof msg>;
}>;

const STATUS_LABEL = {
  working: msg("Working", { $context: "thread status" }),
  attention: msg("Needs attention"),
  idle: msg("Idle", { $context: "thread status" }),
} satisfies Record<SnoozeCandidateStatus, ReturnType<typeof msg>>;

export function snoozeUntilSettledCandidateStatus(
  thread: EnvironmentThreadShell,
): SnoozeCandidateStatus {
  return snoozeCandidateStatus(resolveThreadListV2RowStatus(thread));
}

export interface SnoozeUntilSettledPickerRow {
  readonly thread: EnvironmentThreadShell;
  readonly selected: boolean;
  /** "Project · Working · 5m ago" */
  readonly subtitle: string;
}

export interface SnoozeUntilSettledPicker {
  readonly rows: ReadonlyArray<SnoozeUntilSettledPickerRow>;
  /** The picked threads that are still open, in the order they were picked; confirm sends these. */
  readonly selectedThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Projects that have an open thread to wait on, by title. */
  readonly projectOptions: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  /** "no-candidates" when nothing in the environment is open, "no-matches" when filters hide it all. */
  readonly emptyState: "no-candidates" | "no-matches" | null;
}

export function resolveSnoozeUntilSettledPicker(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly environmentId: EnvironmentId;
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
  readonly selectedThreadIds: ReadonlyArray<ThreadId>;
  readonly query: string;
  readonly messageMatchThreadIds: ReadonlySet<ThreadId>;
  readonly projectId: ProjectId | null;
  readonly status: SnoozeCandidateStatusFilter;
  readonly nowMs: number;
  readonly resolve?: MessageResolver;
}): SnoozeUntilSettledPicker {
  const resolve = input.resolve ?? m;
  const projectTitleById = new Map(
    input.projects
      .filter((project) => project.environmentId === input.environmentId)
      .map((project) => [project.id, project.title]),
  );
  // Every thread goes in, so the cycle check sees subagent and side-chat threads that wait on
  // the snoozed ones. Rows leave them out: they stay under their parent in the list.
  const listed = (thread: EnvironmentThreadShell) => isListedThreadLineage(thread.lineage);
  const shared = {
    threads: input.threads,
    environmentId: input.environmentId,
    excludeThreadIds: input.excludeThreadIds,
    statusOf: snoozeUntilSettledCandidateStatus,
    projectTitleOf: (thread: EnvironmentThreadShell) =>
      projectTitleById.get(thread.projectId) ?? null,
    now: new Date(input.nowMs).toISOString(),
  };

  // Every open thread, unfiltered: what the selection, project menu, and empty state rest on.
  const open = resolveSnoozeUntilSettledCandidates({
    ...shared,
    selectedThreadIds: [],
    query: "",
    projectId: null,
    status: "all",
  }).filter(listed);
  const openById = new Map(open.map((thread) => [thread.id, thread]));
  const selectedThreads = input.selectedThreadIds.flatMap((threadId) => {
    const thread = openById.get(threadId);
    return thread === undefined ? [] : [thread];
  });
  const selected = new Set(selectedThreads.map((thread) => thread.id));

  // The list the user sees, with picked matches first.
  const filtered = resolveSnoozeUntilSettledCandidates({
    ...shared,
    selectedThreadIds: input.selectedThreadIds,
    query: input.query,
    messageMatchThreadIds: input.messageMatchThreadIds,
    projectId: input.projectId,
    status: input.status,
  }).filter(listed);
  const rows = filtered.map((thread) => ({
    thread,
    selected: selected.has(thread.id),
    subtitle: [
      projectTitleById.get(thread.projectId),
      resolve(STATUS_LABEL[snoozeUntilSettledCandidateStatus(thread)]),
      resolve(
        msg("{elapsed} ago", {
          elapsed: relativeTime(
            resolveThreadActivityTimestamp(thread) ?? thread.createdAt,
            input.nowMs,
            resolve,
          ),
        }),
      ),
    ]
      .filter((part) => part !== undefined)
      .join(" · "),
  }));

  const openProjectIds = new Set(open.map((thread) => thread.projectId));
  const projectOptions = [...projectTitleById]
    .filter(([projectId]) => openProjectIds.has(projectId))
    .map(([id, title]) => ({ id, title }))
    .sort((left, right) => left.title.localeCompare(right.title));

  const emptyState = open.length === 0 ? "no-candidates" : rows.length === 0 ? "no-matches" : null;
  return { rows, selectedThreads, projectOptions, emptyState };
}
