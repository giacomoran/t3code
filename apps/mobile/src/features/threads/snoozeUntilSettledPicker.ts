import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  isSnoozeUntilSettledSelected,
  resolveSnoozeUntilSettledCandidates,
  snoozeCandidateStatus,
  type SnoozeCandidateStatus,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  isListedThreadLineage,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
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
  /** "Project · Working · 5m ago", led by the machine when there are several. */
  readonly subtitle: string;
}

export interface SnoozeUntilSettledPicker {
  readonly rows: ReadonlyArray<SnoozeUntilSettledPickerRow>;
  /** The picked threads that are still open, in the order they were picked; confirm sends these. */
  readonly selectedThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Machines to filter by, when threads of linked machines are offered too; else empty. */
  readonly environmentOptions: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  /** Projects that have an open thread to wait on, by title. */
  readonly projectOptions: ReadonlyArray<{
    readonly project: ScopedProjectRef;
    readonly title: string;
  }>;
  /** "no-candidates" when nothing offered is open, "no-matches" when filters hide it all. */
  readonly emptyState: "no-candidates" | "no-matches" | null;
}

export function resolveSnoozeUntilSettledPicker(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** The snoozed threads' environment. */
  readonly environmentId: EnvironmentId;
  /** It and the linked environments whose threads are offered too. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
  readonly selected: ReadonlyArray<ScopedThreadRef>;
  readonly query: string;
  /** `environmentId:threadId` keys of the thread search's message hits. */
  readonly messageMatchThreadKeys: ReadonlySet<string>;
  readonly environmentFilter: EnvironmentId | null;
  readonly project: ScopedProjectRef | null;
  readonly status: SnoozeCandidateStatusFilter;
  readonly nowMs: number;
  readonly resolve?: MessageResolver;
}): SnoozeUntilSettledPicker {
  const resolve = input.resolve ?? m;
  const showsEnvironments = input.environmentIds.length > 1;
  const projectKey = (ref: ScopedProjectRef) => `${ref.environmentId}:${ref.projectId}`;
  const projectTitleByKey = new Map(
    input.projects.map((project) => [
      projectKey({ environmentId: project.environmentId, projectId: project.id }),
      project.title,
    ]),
  );
  const projectTitleOf = (thread: EnvironmentThreadShell) =>
    projectTitleByKey.get(
      projectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
    ) ?? null;
  const environmentLabelOf = (environmentId: EnvironmentId) =>
    input.environmentLabelById.get(environmentId) ?? null;
  // Every thread goes in, so the cycle check sees subagent and side-chat threads that wait on
  // the snoozed ones. Rows leave them out: they stay under their parent in the list.
  const listed = (thread: EnvironmentThreadShell) => isListedThreadLineage(thread.lineage);
  const shared = {
    threads: input.threads,
    environmentId: input.environmentId,
    environmentIds: input.environmentIds,
    excludeThreadIds: input.excludeThreadIds,
    statusOf: snoozeUntilSettledCandidateStatus,
    projectTitleOf,
    environmentLabelOf: (thread: EnvironmentThreadShell) =>
      environmentLabelOf(thread.environmentId),
    now: new Date(input.nowMs).toISOString(),
  };

  // Every open thread, unfiltered: what the selection, menus, and empty state rest on.
  const open = resolveSnoozeUntilSettledCandidates({
    ...shared,
    selected: [],
    query: "",
    environmentFilter: null,
    project: null,
    status: "all",
  }).filter(listed);
  const openByKey = new Map(open.map((thread) => [`${thread.environmentId}:${thread.id}`, thread]));
  const selectedThreads = input.selected.flatMap((ref) => {
    const thread = openByKey.get(`${ref.environmentId}:${ref.threadId}`);
    return thread === undefined ? [] : [thread];
  });
  const selectedRefs = selectedThreads.map(refOf);

  // The list the user sees, with picked matches first.
  const filtered = resolveSnoozeUntilSettledCandidates({
    ...shared,
    selected: input.selected,
    query: input.query,
    messageMatchThreadKeys: input.messageMatchThreadKeys,
    environmentFilter: input.environmentFilter,
    project: input.project,
    status: input.status,
  }).filter(listed);
  const rows = filtered.map((thread) => ({
    thread,
    selected: isSnoozeUntilSettledSelected(selectedRefs, refOf(thread)),
    subtitle: [
      showsEnvironments ? environmentLabelOf(thread.environmentId) : null,
      projectTitleOf(thread),
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
      .filter((part) => part !== null)
      .join(" · "),
  }));

  const environmentOptions = showsEnvironments
    ? input.environmentIds.map((environmentId) => ({
        environmentId,
        label: environmentLabelOf(environmentId) ?? environmentId,
      }))
    : [];
  // A project shows once a machine filter allows it; with several machines, it names its own.
  const projectOptionByKey = new Map<string, SnoozeUntilSettledPicker["projectOptions"][number]>();
  for (const thread of open) {
    if (input.environmentFilter !== null && thread.environmentId !== input.environmentFilter) {
      continue;
    }
    const title = projectTitleOf(thread);
    if (title === null) continue;
    const project = { environmentId: thread.environmentId, projectId: thread.projectId };
    const label = environmentLabelOf(thread.environmentId);
    projectOptionByKey.set(projectKey(project), {
      project,
      title: showsEnvironments && label !== null ? `${title} · ${label}` : title,
    });
  }
  const projectOptions = [...projectOptionByKey.values()].sort((left, right) =>
    left.title.localeCompare(right.title),
  );

  const emptyState = open.length === 0 ? "no-candidates" : rows.length === 0 ? "no-matches" : null;
  return { rows, selectedThreads, environmentOptions, projectOptions, emptyState };
}

function refOf(thread: EnvironmentThreadShell): ScopedThreadRef {
  return { environmentId: thread.environmentId, threadId: thread.id };
}
