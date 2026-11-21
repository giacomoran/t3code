import {
  EnvironmentId,
  ProjectId,
  THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  presentThreadSnoozeUntilSettled,
  resolveSnoozeUntilSettledCandidates,
  snoozeCandidateStatus,
  snoozedUntilSettledLabel,
  toggleSnoozeUntilSettledSelection,
  type SnoozeCandidateStatus,
  type SnoozeCandidateThread,
  type SnoozeUntilSettledCandidatesInput,
} from "./threadSnoozeUntilSettled.ts";

const NOW = "2026-11-19T12:00:00.000Z";
const SNOOZED_AT = "2026-11-18T12:00:00.000Z";
const CAP = "2026-12-18T12:00:00.000Z";
const first = ThreadId.make("thread-first");
const second = ThreadId.make("thread-second");

describe("presentThreadSnoozeUntilSettled", () => {
  const shell = (input: {
    readonly snoozedUntil: string;
    readonly threadIds: ReadonlyArray<ThreadId> | null;
    readonly pendingApproval?: boolean;
  }) => ({
    snoozedUntil: input.snoozedUntil,
    snoozedAt: SNOOZED_AT,
    snoozeUntilSettledThreadIds: input.threadIds,
    hasPendingApprovals: input.pendingApproval === true,
    hasPendingUserInput: false,
  });
  const BEFORE_NOW = "2026-11-19T11:00:00.000Z";
  const AFTER_NOW = "2026-11-19T13:00:00.000Z";
  const open = { settledOverride: null, settledAt: null, archivedAt: null };
  const settled = { settledOverride: "settled" as const, settledAt: BEFORE_NOW, archivedAt: null };
  const archived = { settledOverride: null, settledAt: null, archivedAt: BEFORE_NOW };

  it.each([
    {
      name: "waits on the listed threads",
      shell: shell({ snoozedUntil: CAP, threadIds: [first, second] }),
      threadById: () => open,
      expected: { waitingCount: 2, wokeLabel: null },
    },
    {
      name: "says why it woke once they all settled or went away",
      shell: shell({ snoozedUntil: NOW, threadIds: [first, second] }),
      threadById: (threadId: ThreadId) => (threadId === first ? settled : undefined),
      expected: { waitingCount: null, wokeLabel: "Threads settled" },
    },
    {
      name: "gives a cap wake no reason while a listed thread is still open",
      shell: shell({ snoozedUntil: NOW, threadIds: [first, second] }),
      threadById: (threadId: ThreadId) => (threadId === first ? settled : open),
      expected: { waitingCount: null, wokeLabel: null },
    },
    {
      name: "counts an archived thread as finished",
      shell: shell({ snoozedUntil: NOW, threadIds: [first] }),
      threadById: () => archived,
      expected: { waitingCount: null, wokeLabel: "Threads settled" },
    },
    {
      name: "gives a cap wake no reason once a thread settles after it",
      shell: shell({ snoozedUntil: NOW, threadIds: [first, second] }),
      threadById: (threadId: ThreadId) =>
        threadId === first ? settled : { ...settled, settledAt: AFTER_NOW },
      expected: { waitingCount: null, wokeLabel: null },
    },
    {
      name: "gives a cap wake no reason once a thread is archived after it",
      shell: shell({ snoozedUntil: NOW, threadIds: [first] }),
      threadById: () => ({ ...archived, archivedAt: AFTER_NOW }),
      expected: { waitingCount: null, wokeLabel: null },
    },
    {
      name: "gives a wake on a request no reason",
      shell: shell({ snoozedUntil: CAP, threadIds: [first], pendingApproval: true }),
      threadById: () => settled,
      expected: { waitingCount: null, wokeLabel: null },
    },
    {
      name: "leaves a time snooze alone",
      shell: shell({ snoozedUntil: CAP, threadIds: null }),
      threadById: () => settled,
      expected: { waitingCount: null, wokeLabel: null },
    },
  ])("$name", ({ shell, threadById, expected }) => {
    expect(presentThreadSnoozeUntilSettled(shell, { now: NOW, threadById })).toMatchObject(
      expected,
    );
  });

  it("names one thread in the singular", () => {
    expect(snoozedUntilSettledLabel(1)).toBe("Snoozed until 1 thread settles");
    expect(snoozedUntilSettledLabel(3)).toBe("Snoozed until 3 threads settle");
  });
});

describe("resolveSnoozeUntilSettledCandidates", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const projectA = ProjectId.make("project-a");
  const projectB = ProjectId.make("project-b");
  type Candidate = SnoozeCandidateThread & { readonly status: SnoozeCandidateStatus };
  const thread = (
    id: string,
    overrides: Partial<Candidate> & Pick<Candidate, "updatedAt">,
  ): Candidate => ({
    environmentId,
    id: ThreadId.make(id),
    projectId: projectA,
    title: id,
    branch: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    latestUserMessageAt: null,
    latestUserAuthoredMessageAt: null,
    opens: null,
    archivedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozeUntilSettledThreadIds: null,
    status: "idle",
    ...overrides,
  });
  const threads = [
    thread("snoozed", { updatedAt: "2026-11-19T11:00:00.000Z" }),
    thread("idle-old", { updatedAt: "2026-11-10T00:00:00.000Z", title: "Fix the parser" }),
    thread("idle-new", { updatedAt: "2026-11-18T00:00:00.000Z", projectId: projectB }),
    thread("working-old", { updatedAt: "2026-11-01T00:00:00.000Z", status: "working" }),
    thread("attention", { updatedAt: "2026-11-15T00:00:00.000Z", status: "attention" }),
    thread("settled", { updatedAt: "2026-11-19T00:00:00.000Z", settledOverride: "settled" }),
    thread("archived", { updatedAt: "2026-11-19T00:00:00.000Z", archivedAt: NOW }),
    thread("elsewhere", {
      updatedAt: "2026-11-19T00:00:00.000Z",
      environmentId: EnvironmentId.make("environment-remote"),
    }),
    // Waits on "snoozed" directly, and "waits-on-waiter" through it: both would make a cycle.
    thread("waiter", {
      updatedAt: "2026-11-19T00:00:00.000Z",
      snoozedUntil: "2026-12-01T00:00:00.000Z",
      snoozeUntilSettledThreadIds: [ThreadId.make("snoozed")],
    }),
    thread("waits-on-waiter", {
      updatedAt: "2026-11-19T00:00:00.000Z",
      snoozedUntil: "2026-12-01T00:00:00.000Z",
      snoozeUntilSettledThreadIds: [ThreadId.make("waiter")],
    }),
    // Its snooze on "snoozed" already woke, so it no longer waits.
    thread("woke-waiter", {
      updatedAt: "2026-11-02T00:00:00.000Z",
      snoozedUntil: NOW,
      snoozeUntilSettledThreadIds: [ThreadId.make("snoozed")],
    }),
  ];
  const resolve = (overrides: Partial<SnoozeUntilSettledCandidatesInput<Candidate>>) =>
    resolveSnoozeUntilSettledCandidates({
      threads,
      environmentId,
      excludeThreadIds: [ThreadId.make("snoozed")],
      selectedThreadIds: [],
      query: "",
      projectId: null,
      status: "all",
      statusOf: (candidate) => candidate.status,
      projectTitleOf: (candidate) => (candidate.projectId === projectB ? "Billing" : "Parser"),
      now: NOW,
      ...overrides,
    }).map((candidate) => candidate.id);

  it.each([
    {
      name: "lists open threads here, working first, then the most recently updated, leaving out threads waiting on the snoozed one",
      input: {},
      expected: ["working-old", "idle-new", "attention", "idle-old", "woke-waiter"],
    },
    {
      name: "lists selected threads first",
      input: { selectedThreadIds: [ThreadId.make("idle-old")] },
      expected: ["idle-old", "working-old", "idle-new", "attention", "woke-waiter"],
    },
    { name: "filters by project", input: { projectId: projectB }, expected: ["idle-new"] },
    {
      name: "filters by status",
      input: { status: "attention" as const },
      expected: ["attention"],
    },
    { name: "matches the title", input: { query: "parser fix" }, expected: ["idle-old"] },
    { name: "matches the project name", input: { query: "billing" }, expected: ["idle-new"] },
    {
      name: "matches message search hits",
      input: { query: "stack trace", messageMatchThreadIds: new Set([ThreadId.make("attention")]) },
      expected: ["attention"],
    },
  ])("$name", ({ input, expected }) => {
    expect(resolve(input)).toEqual(expected);
  });

  it("groups row statuses for the status filter", () => {
    expect(
      (["working", "waiting", "input", "limited", "ready"] as const).map(snoozeCandidateStatus),
    ).toEqual(["working", "working", "attention", "attention", "idle"]);
  });
});

describe("toggleSnoozeUntilSettledSelection", () => {
  it("unpicks at the limit but picks no more", () => {
    const full = Array.from({ length: THREAD_SNOOZE_UNTIL_SETTLED_MAX_THREADS }, (_, index) =>
      ThreadId.make(`thread-${index}`),
    );
    expect(toggleSnoozeUntilSettledSelection(full, ThreadId.make("thread-extra"))).toBe(full);
    expect(toggleSnoozeUntilSettledSelection(full, full[0]!)).toHaveLength(full.length - 1);
  });
});
