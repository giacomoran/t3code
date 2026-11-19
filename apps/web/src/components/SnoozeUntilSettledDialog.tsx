import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { create } from "zustand";
import {
  resolveSnoozeUntilSettledCandidates,
  SNOOZE_UNTIL_SETTLED_LIMIT_HINT,
  snoozeCandidateStatus,
  snoozeUntilSettledPhrase,
  toggleSnoozeUntilSettledSelection,
  type SnoozeCandidateStatus,
  type SnoozeCandidateStatusFilter,
} from "@t3tools/client-runtime/state/thread-snooze-until-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";

import { useNowMinute } from "../hooks/useNowMinute";
import { cn } from "../lib/utils";
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { useThreadSearch } from "../state/queries";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { resolveSidebarRowStatus } from "./Sidebar.logic";
import type { SnoozeChoice } from "./Sidebar.snooze";
import {
  moveHighlightedThreadId,
  resolveHighlightedThreadId,
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
  { value: "all", label: "All" },
  { value: "working", label: "Working" },
  { value: "attention", label: "Needs attention" },
  { value: "idle", label: "Idle" },
];

const STATUS_PRESENTATION = {
  working: { label: "Working", className: "text-info-foreground" },
  attention: { label: "Needs attention", className: "text-warning-foreground" },
  idle: { label: "Idle", className: "text-muted-foreground" },
} satisfies Record<SnoozeCandidateStatus, { label: string; className: string }>;

const ALL_PROJECTS = "all";

function statusOf(thread: EnvironmentThreadShell): SnoozeCandidateStatus {
  return snoozeCandidateStatus(resolveSidebarRowStatus(thread));
}

function SnoozeUntilSettledDialog(props: SnoozeUntilSettledInput) {
  const { environmentId, excludeThreadIds } = props;
  const listId = useId();
  const nowMinute = useNowMinute();
  // The tick is a UTC minute without a zone; read as local time it would shift by the offset.
  const nowIso = `${nowMinute}:00.000Z`;
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [status, setStatus] = useState<SnoozeCandidateStatusFilter>("all");
  const [selectedThreadIds, setSelectedThreadIds] = useState<ReadonlyArray<ThreadId>>([]);
  // Picked threads lead the list, but only from the next search or filter change, so a row
  // does not jump away from the highlight the moment it is toggled.
  const [leadingThreadIds, setLeadingThreadIds] = useState<ReadonlyArray<ThreadId>>([]);
  const [highlightedThreadId, setHighlightedThreadId] = useState<ThreadId | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);

  const shells = useVisibleThreadShells();
  const projects = useProjects();
  const projectTitleById = new Map(
    projects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title] as const),
  );
  const projectTitleOf = (thread: EnvironmentThreadShell) =>
    projectTitleById.get(thread.projectId) ?? null;
  const messageSearch = useThreadSearch(
    [environmentId],
    query,
    projectId === null ? {} : { projectIds: [projectId] },
  );
  const messageMatchThreadIds = new Set(
    messageSearch.matches
      .filter((match) => match.environmentId === environmentId)
      .map((match) => match.threadId),
  );

  // Every thread the snooze could wait on, before the search and filters narrow it.
  const openThreads = resolveSnoozeUntilSettledCandidates({
    threads: shells,
    environmentId,
    excludeThreadIds,
    selectedThreadIds: [],
    query: "",
    projectId: null,
    status: "all",
    statusOf,
    projectTitleOf,
    now: nowIso,
  });
  const openThreadById = new Map(openThreads.map((thread) => [thread.id, thread] as const));
  const candidates = resolveSnoozeUntilSettledCandidates({
    threads: openThreads,
    environmentId,
    excludeThreadIds,
    selectedThreadIds: leadingThreadIds,
    query,
    messageMatchThreadIds,
    projectId,
    status,
    statusOf,
    projectTitleOf,
    now: nowIso,
  });
  const candidateIds = candidates.map((thread) => thread.id);
  // A picked thread that settled or went away meanwhile has nothing left to wait for.
  const selectedThreads = selectedThreadIds.flatMap((threadId) => {
    const thread = openThreadById.get(threadId);
    return thread === undefined ? [] : [thread];
  });
  const projectOptions = snoozeUntilSettledProjectOptions(openThreads, projectTitleOf);
  const highlighted = resolveHighlightedThreadId(candidateIds, highlightedThreadId);
  const optionId = (threadId: ThreadId) => `${listId}-${threadId}`;

  const toggle = (threadId: ThreadId) => {
    setSelectedThreadIds((current) => toggleSnoozeUntilSettledSelection(current, threadId));
  };
  const confirm = (threadIds: ReadonlyArray<ThreadId>) => {
    if (threadIds.length === 0) return;
    // oxlint-disable-next-line react/purity -- runs in an event handler (oxc#27309)
    finish(snoozeUntilSettledChoice(threadIds, new Date()));
  };
  const narrow = (apply: () => void) => {
    apply();
    setLeadingThreadIds(selectedThreadIds);
    setHighlightedThreadId(null);
    setIsNavigating(false);
  };
  const highlight = (threadId: ThreadId | null) => {
    setHighlightedThreadId(threadId);
    if (threadId !== null) {
      document.getElementById(optionId(threadId))?.scrollIntoView({ block: "nearest" });
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
        moveHighlightedThreadId(candidateIds, highlighted, action === "move-down" ? "down" : "up"),
      );
      return;
    }
    if (action === "toggle") {
      toggle(highlighted!);
      return;
    }
    if (action === "confirm") {
      confirm(selectedThreads.map((thread) => thread.id));
      return;
    }
    if (action === "toggle-and-confirm") {
      confirm([highlighted!]);
      return;
    }
    throw new Error(`Unreachable: unexpected key action ${action satisfies never}`);
  };

  const snoozedCount = excludeThreadIds.length;
  const nowMs = Date.parse(nowIso);
  const emptyMessage =
    openThreads.length === 0
      ? "No other open threads in this environment to wait on."
      : messageSearch.isPending
        ? "Searching…"
        : "No threads match.";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Snooze until threads settle</DialogTitle>
          <DialogDescription>
            {snoozedCount === 1 ? "This thread returns" : `These ${snoozedCount} threads return`} to
            your inbox once every thread you pick is settled, archived, or deleted, or after 30
            days.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-4">
          <Input
            autoFocus
            type="search"
            size="lg"
            role="combobox"
            aria-label="Search threads"
            aria-controls={listId}
            aria-expanded
            aria-autocomplete="list"
            aria-activedescendant={highlighted === null ? undefined : optionId(highlighted)}
            placeholder="Search titles, projects, and messages…"
            value={query}
            onChange={(event) => {
              const value = event.target.value;
              narrow(() => setQuery(value));
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={projectId ?? ALL_PROJECTS}
              items={{
                [ALL_PROJECTS]: "All projects",
                ...Object.fromEntries(
                  projectOptions.map((option) => [option.projectId, option.title]),
                ),
              }}
              onValueChange={(value) => {
                const option = projectOptions.find((candidate) => candidate.projectId === value);
                narrow(() => setProjectId(option?.projectId ?? null));
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-36" aria-label="Project">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projectOptions.map((option) => (
                  <SelectItem key={option.projectId} value={option.projectId}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <ToggleGroup
              aria-label="Status"
              value={[status]}
              onValueChange={(next) => {
                const value = STATUS_FILTERS.find((filter) => filter.value === next[0])?.value;
                if (value !== undefined) narrow(() => setStatus(value));
              }}
            >
              {STATUS_FILTERS.map((filter) => (
                <Toggle key={filter.value} value={filter.value}>
                  {filter.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </div>
          {selectedThreads.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Picked threads">
              {selectedThreads.map((thread) => (
                <Badge key={thread.id} variant="outline" size="lg" className="max-w-full">
                  <span className="truncate">{thread.title}</span>
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    aria-label={`Remove ${thread.title}`}
                    onClick={() => toggle(thread.id)}
                  >
                    <XIcon />
                  </Button>
                </Badge>
              ))}
            </div>
          ) : null}
          {selectedThreadIds.length >= THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS ? (
            <p className="text-muted-foreground text-xs">{SNOOZE_UNTIL_SETTLED_LIMIT_HINT}</p>
          ) : null}
          <div
            id={listId}
            role="listbox"
            aria-label="Threads"
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
                const isSelected = selectedThreadIds.includes(thread.id);
                const threadStatus = STATUS_PRESENTATION[statusOf(thread)];
                const activityAt = resolveThreadActivityTimestamp(thread);
                const projectTitle = projectTitleOf(thread);
                return (
                  <div
                    key={thread.id}
                    id={optionId(thread.id)}
                    role="option"
                    aria-selected={isSelected}
                    data-highlighted={thread.id === highlighted || undefined}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 data-highlighted:bg-foreground/[0.09]"
                    // Keeps focus in the search box, which drives the keyboard.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (thread.id !== highlighted) setHighlightedThreadId(thread.id);
                    }}
                    onClick={() => toggle(thread.id)}
                  >
                    <CheckboxMark checked={isSelected} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{thread.title}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
                        {projectTitle === null ? null : (
                          <>
                            <span className="truncate">{projectTitle}</span>
                            <span aria-hidden>·</span>
                          </>
                        )}
                        <span className={cn("shrink-0", threadStatus.className)}>
                          {threadStatus.label}
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
              <span>Navigate</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Space</Kbd>
              <span>Pick</span>
            </KbdGroup>
            <KbdGroup>
              <Kbd>Enter</Kbd>
              <span>Snooze</span>
            </KbdGroup>
          </div>
          <Button type="button" variant="outline" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={selectedThreads.length === 0}
            onClick={() => confirm(selectedThreads.map((thread) => thread.id))}
          >
            {selectedThreads.length === 0
              ? "Snooze"
              : `Snooze ${snoozeUntilSettledPhrase(selectedThreads.length)}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
