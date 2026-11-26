import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import { scopedProjectKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isSnoozeUntilSettledSelected,
  resolveSnoozeUntilSettledCandidates,
  snoozeCandidateStatus,
  snoozeUntilSettledActionLabel,
  snoozeUntilSettledLimitHint,
  toggleSnoozeUntilSettledSelection,
  type SnoozeCandidateStatus,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import {
  readEnvironmentSupportsSnoozeUntilSettledLinked,
  useProjects,
  useVisibleThreadShells,
} from "../state/entities";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../state/environments";
import { useLinkedEnvironments } from "../state/peerLinks";
import { useThreadSearch } from "../state/queries";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveSidebarRowStatus } from "./Sidebar.logic";
import type { SnoozeChoice } from "./Sidebar.snooze";
import {
  moveHighlightedThreadKey,
  resolveHighlightedThreadKey,
  resolveSnoozeUntilSettledKey,
  snoozeUntilSettledChoice,
  snoozeUntilSettledProjectOptions,
} from "./snoozeUntilSettled.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { CheckboxMark } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Kbd, KbdGroup } from "./ui/kbd";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

type SnoozeUntilSettledInput = {
  readonly environmentId: EnvironmentId;
  /** The threads being snoozed; they cannot wait on themselves. */
  readonly excludeThreadIds: ReadonlyArray<ThreadId>;
};
type Request = SnoozeUntilSettledInput & {
  /** Remounts the picker for a new request, so it starts empty. */
  readonly id: number;
  readonly resolve: (choice: SnoozeChoice | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));
let nextRequestId = 0;

/** Asks which threads to wait on; resolves with a snooze that carries them and its cap. */
export function requestSnoozeUntilSettled(
  input: SnoozeUntilSettledInput,
): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  nextRequestId += 1;
  const id = nextRequestId;
  return new Promise((resolve) => useRequest.setState({ request: { ...input, id, resolve } }));
}

function finish(choice: SnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function SnoozeUntilSettledDialogHost() {
  const request = useRequest((state) => state.request);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- resolves any pending snooze request promise with null when the dialog host unmounts
  useEffect(() => () => finish(null), []);
  return request ? (
    <SnoozeUntilSettledDialog
      key={request.id}
      environmentId={request.environmentId}
      excludeThreadIds={request.excludeThreadIds}
    />
  ) : null;
}

const STATUS_FILTERS: ReadonlyArray<{
  readonly value: SnoozeCandidateStatusFilter;
  readonly label: string;
}> = [
  { value: "all", label: msg("All", { $context: "thread status filter" }) },
  { value: "working", label: msg("Working", { $context: "thread status" }) },
  { value: "attention", label: msg("Needs attention") },
  { value: "idle", label: msg("Idle", { $context: "thread status" }) },
];

const STATUS_PRESENTATION = {
  working: {
    label: msg("Working", { $context: "thread status" }),
    className: "text-info-foreground",
  },
  attention: { label: msg("Needs attention"), className: "text-warning-foreground" },
  idle: { label: msg("Idle", { $context: "thread status" }), className: "text-muted-foreground" },
} satisfies Record<SnoozeCandidateStatus, { label: string; className: string }>;

const ALL_PROJECTS = "all";
const ALL_ENVIRONMENTS = "all";

function statusOf(thread: EnvironmentThreadShell): SnoozeCandidateStatus {
  return snoozeCandidateStatus(resolveSidebarRowStatus(thread));
}

function refOf(thread: EnvironmentThreadShell): ScopedThreadRef {
  return { environmentId: thread.environmentId, threadId: thread.id };
}

function SnoozeUntilSettledDialog(props: SnoozeUntilSettledInput) {
  const { environmentId, excludeThreadIds } = props;
  const gt = useGT();
  const messages = useMessages();
  const listId = useId();
  const nowMinute = useNowMinute();
  // The tick is a UTC minute without a zone; read as local time it would shift by the offset.
  const nowIso = `${nowMinute}:00.000Z`;
  const [query, setQuery] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState<EnvironmentId | null>(null);
  const [project, setProject] = useState<ScopedProjectRef | null>(null);
  const [status, setStatus] = useState<SnoozeCandidateStatusFilter>("all");
  const [selected, setSelected] = useState<ReadonlyArray<ScopedThreadRef>>([]);
  // Picked threads lead the list, but only from the next search or filter change, so a row
  // does not jump away from the highlight the moment it is toggled.
  const [leading, setLeading] = useState<ReadonlyArray<ScopedThreadRef>>([]);
  const [highlightedThreadKey, setHighlightedThreadKey] = useState<string | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);

  // Threads of machines the snoozed thread's server links to can be picked too, when that
  // server can wait on them and this client has their threads.
  const supportsLinked = readEnvironmentSupportsSnoozeUntilSettledLinked(environmentId);
  const linkedEnvironments = useLinkedEnvironments(supportsLinked ? environmentId : null);
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const environmentIds = [
    environmentId,
    ...connectedEnvironmentIds.filter(
      (candidate) => candidate !== environmentId && linkedEnvironments.has(candidate),
    ),
  ];
  const identities = useEnvironmentIdentities();
  const environmentLabelById = new Map(
    identities.map((identity) => [identity.environmentId, identity.label] as const),
  );
  const environmentLabelOf = (thread: EnvironmentThreadShell) =>
    environmentLabelById.get(thread.environmentId) ??
    linkedEnvironments.get(thread.environmentId) ??
    null;
  const showsEnvironments = environmentIds.length > 1;

  const shells = useVisibleThreadShells();
  const projects = useProjects();
  const projectTitleByKey = new Map(
    projects.map(
      (candidate) =>
        [
          scopedProjectKey({ environmentId: candidate.environmentId, projectId: candidate.id }),
          candidate.title,
        ] as const,
    ),
  );
  const projectTitleOf = (thread: EnvironmentThreadShell) =>
    projectTitleByKey.get(
      scopedProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
    ) ?? null;
  const searchEnvironmentIds =
    project !== null
      ? [project.environmentId]
      : environmentFilter !== null
        ? [environmentFilter]
        : environmentIds;
  const messageSearch = useThreadSearch(
    searchEnvironmentIds,
    query,
    project === null ? {} : { projectIds: [project.projectId] },
  );
  const messageMatchThreadKeys = new Set(messageSearch.matches.map(scopedThreadKey));

  // Every thread the snooze could wait on, before the search and filters narrow it.
  const candidateFilters = {
    environmentId,
    environmentIds,
    excludeThreadIds,
    statusOf,
    projectTitleOf,
    environmentLabelOf,
    now: nowIso,
  };
  const openThreads = resolveSnoozeUntilSettledCandidates({
    ...candidateFilters,
    threads: shells,
    selected: [],
    query: "",
    environmentFilter: null,
    project: null,
    status: "all",
  });
  const openThreadByKey = new Map(
    openThreads.map((thread) => [scopedThreadKey(refOf(thread)), thread] as const),
  );
  const candidates = resolveSnoozeUntilSettledCandidates({
    ...candidateFilters,
    threads: openThreads,
    selected: leading,
    query,
    messageMatchThreadKeys,
    environmentFilter,
    project,
    status,
  });
  const candidateKeys = candidates.map((thread) => scopedThreadKey(refOf(thread)));
  // A picked thread that settled or went away meanwhile has nothing left to wait for.
  const selectedThreads = selected.flatMap((ref) => {
    const thread = openThreadByKey.get(scopedThreadKey(ref));
    return thread === undefined ? [] : [thread];
  });
  const projectOptions = snoozeUntilSettledProjectOptions(
    environmentFilter === null
      ? openThreads
      : openThreads.filter((thread) => thread.environmentId === environmentFilter),
    projectTitleOf,
  );
  const projectOptionLabel = (option: (typeof projectOptions)[number]) => {
    const label = environmentLabelById.get(option.project.environmentId);
    return showsEnvironments && label !== undefined ? `${option.title} · ${label}` : option.title;
  };
  const highlighted = resolveHighlightedThreadKey(candidateKeys, highlightedThreadKey);
  const optionId = (threadKey: string) => `${listId}-${threadKey}`;

  const toggle = (ref: ScopedThreadRef) => {
    setSelected((current) => toggleSnoozeUntilSettledSelection(current, ref));
  };
  const toggleKey = (threadKey: string) => {
    const thread = openThreadByKey.get(threadKey);
    if (thread === undefined) throw new Error(`Thread ${threadKey} is not listed`);
    toggle(refOf(thread));
  };
  const confirm = (picks: ReadonlyArray<ScopedThreadRef>) => {
    if (picks.length === 0) return;
    finish(snoozeUntilSettledChoice(environmentId, picks, new Date()));
  };
  const narrow = (apply: () => void) => {
    apply();
    setLeading(selected);
    setHighlightedThreadKey(null);
    setIsNavigating(false);
  };
  const highlight = (threadKey: string | null) => {
    setHighlightedThreadKey(threadKey);
    if (threadKey !== null) {
      document.getElementById(optionId(threadKey))?.scrollIntoView({ block: "nearest" });
    }
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = resolveSnoozeUntilSettledKey({
      key: event.key,
      isComposing: event.nativeEvent.isComposing,
      query,
      isNavigating,
      hasHighlight: highlighted !== null,
      selectedCount: selectedThreads.length,
    });
    if (action === null) return;
    event.preventDefault();
    if (action === "move-down" || action === "move-up") {
      setIsNavigating(true);
      highlight(
        moveHighlightedThreadKey(
          candidateKeys,
          highlighted,
          action === "move-down" ? "down" : "up",
        ),
      );
      return;
    }
    if (action === "toggle") {
      toggleKey(highlighted!);
      return;
    }
    if (action === "confirm") {
      confirm(selectedThreads.map(refOf));
      return;
    }
    if (action === "toggle-and-confirm") {
      confirm([refOf(openThreadByKey.get(highlighted!)!)]);
      return;
    }
    throw new Error(`Unreachable: unexpected key action ${action satisfies never}`);
  };

  const snoozedCount = excludeThreadIds.length;
  const nowMs = Date.parse(nowIso);
  const emptyMessage =
    openThreads.length === 0
      ? showsEnvironments
        ? gt("No other open threads to wait on.")
        : gt("No other open threads in this environment to wait on.")
      : messageSearch.isPending
        ? gt("Searching…")
        : gt("No threads match.");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{gt("Snooze until threads settle")}</DialogTitle>
          <DialogDescription>
            {gt(
              "{count, plural, =1 {This thread returns} other {These {count} threads return}} to your inbox once every thread you pick is settled, archived, or deleted, or after 30 days.",
              { count: snoozedCount },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-4">
          <Input
            autoFocus
            type="search"
            size="lg"
            role="combobox"
            aria-label={gt("Search threads")}
            aria-controls={listId}
            aria-expanded
            aria-autocomplete="list"
            aria-activedescendant={highlighted === null ? undefined : optionId(highlighted)}
            placeholder={gt("Search titles, projects, and messages…")}
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              narrow(() => setQuery(value));
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <div className="flex flex-wrap items-center gap-2">
            {showsEnvironments ? (
              <Select
                value={environmentFilter ?? ALL_ENVIRONMENTS}
                items={{
                  [ALL_ENVIRONMENTS]: gt("All machines"),
                  ...Object.fromEntries(
                    environmentIds.map((candidate) => [
                      candidate,
                      environmentLabelById.get(candidate) ?? candidate,
                    ]),
                  ),
                }}
                onValueChange={(value) => {
                  const next = environmentIds.find((candidate) => candidate === value) ?? null;
                  narrow(() => {
                    setEnvironmentFilter(next);
                    setProject(null);
                  });
                }}
              >
                <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={gt("Machine")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={ALL_ENVIRONMENTS}>{gt("All machines")}</SelectItem>
                  {environmentIds.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {environmentLabelById.get(candidate) ?? candidate}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Select
              value={project === null ? ALL_PROJECTS : scopedProjectKey(project)}
              items={{
                [ALL_PROJECTS]: gt("All projects"),
                ...Object.fromEntries(
                  projectOptions.map((option) => [
                    scopedProjectKey(option.project),
                    projectOptionLabel(option),
                  ]),
                ),
              }}
              onValueChange={(value) => {
                const option = projectOptions.find(
                  (candidate) => scopedProjectKey(candidate.project) === value,
                );
                narrow(() => setProject(option?.project ?? null));
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-36" aria-label={gt("Project")}>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ALL_PROJECTS}>{gt("All projects")}</SelectItem>
                {projectOptions.map((option) => (
                  <SelectItem
                    key={scopedProjectKey(option.project)}
                    value={scopedProjectKey(option.project)}
                  >
                    {projectOptionLabel(option)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              aria-label={gt("Status")}
              value={[status]}
              onValueChange={(next) => {
                const value = STATUS_FILTERS.find((filter) => filter.value === next[0])?.value;
                if (value !== undefined) narrow(() => setStatus(value));
              }}
            >
              {STATUS_FILTERS.map((filter) => (
                <Toggle key={filter.value} value={filter.value}>
                  {messages(filter.label)}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
          {selectedThreads.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" aria-label={gt("Picked threads")}>
              {selectedThreads.map((thread) => (
                <Badge
                  key={scopedThreadKey(refOf(thread))}
                  variant="outline"
                  size="lg"
                  className="max-w-full"
                >
                  <span className="truncate">{thread.title}</span>
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={gt("Remove {title}", { title: thread.title })}
                    onClick={() => toggle(refOf(thread))}
                  >
                    <XIcon />
                  </Button>
                </Badge>
              ))}
            </div>
          ) : null}
          {selected.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS ? (
            <p className="text-muted-foreground text-xs">{snoozeUntilSettledLimitHint(messages)}</p>
          ) : null}
          <div
            id={listId}
            role="listbox"
            aria-label={gt("Threads")}
            aria-multiselectable
            className="-mx-2 max-h-[min(22rem,50vh)] min-h-24 overflow-y-auto"
          >
            {candidates.length === 0 ? (
              <div className="flex h-24 flex-col items-center justify-center gap-2 text-muted-foreground text-sm">
                <SearchIcon className="size-4 text-icon-muted" />
                {emptyMessage}
              </div>
            ) : (
              candidates.map((thread) => {
                const ref = refOf(thread);
                const threadKey = scopedThreadKey(ref);
                const isSelected = isSnoozeUntilSettledSelected(selected, ref);
                const threadStatus = STATUS_PRESENTATION[statusOf(thread)];
                const activityAt = resolveThreadActivityTimestamp(thread);
                const projectTitle = projectTitleOf(thread);
                const environmentLabel = showsEnvironments ? environmentLabelOf(thread) : null;
                return (
                  <div
                    key={threadKey}
                    id={optionId(threadKey)}
                    role="option"
                    aria-selected={isSelected}
                    data-highlighted={threadKey === highlighted || undefined}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 data-highlighted:bg-foreground/[0.09]"
                    // Keeps focus in the search box, which drives the keyboard.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (threadKey !== highlighted) setHighlightedThreadKey(threadKey);
                    }}
                    onClick={() => toggle(ref)}
                  >
                    <CheckboxMark checked={isSelected} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{thread.title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                        {environmentLabel === null ? null : (
                          <>
                            <span className="shrink-0">{environmentLabel}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        {projectTitle === null ? null : (
                          <>
                            <span className="truncate">{projectTitle}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        <span className={cn("shrink-0", threadStatus.className)}>
                          {messages(threadStatus.label)}
                        </span>
                        {activityAt === null ? null : (
                          <>
                            <span aria-hidden>·</span>
                            <span className="shrink-0 tabular-nums">
                              {formatRelativeTimeLabel(activityAt, nowMs)}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        <DialogFooter>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs max-sm:hidden sm:mr-auto">
            <KbdGroup>
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <T>
                <span>Navigate</span>
              </T>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Space</Kbd>
              <T>
                <span>Pick</span>
              </T>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Enter</Kbd>
              <T>
                <span>Snooze</span>
              </T>
            </KbdGroup>
          </div>
          <Button type="button" variant="outline" onClick={() => finish(null)}>
            <T>Cancel</T>
          </Button>
          <Button
            type="button"
            disabled={selectedThreads.length === 0}
            onClick={() => confirm(selectedThreads.map(refOf))}
          >
            {selectedThreads.length === 0
              ? gt("Snooze", { $context: "button: snooze the thread" })
              : snoozeUntilSettledActionLabel(selectedThreads.length, messages)}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
