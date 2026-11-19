import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { resolveSnoozeUntilSettledPicker } from "./snoozeUntilSettledPicker";

const environmentId = EnvironmentId.make("environment");
const appProjectId = ProjectId.make("app");
const docsProjectId = ProjectId.make("docs");
const emptyProjectId = ProjectId.make("empty");
const NOW_MS = Date.parse("2026-06-02T12:00:00.000Z");

function makeProject(id: ProjectId, title: string): EnvironmentProject {
  return {
    environmentId,
    id,
    title,
    workspaceRoot: `/work/${id}`,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeThread(
  id: string,
  input: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    environmentId,
    id: ThreadId.make(id),
    title: id,
    projectId: appProjectId,
    updatedAt: "2026-06-02T11:00:00.000Z",
    ...input,
  });
}

const running = {
  status: "running",
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-06-02T11:55:00.000Z",
} as const;

const threads = [
  makeThread("snoozing"),
  makeThread("idle-app"),
  makeThread("working-docs", {
    projectId: docsProjectId,
    runtime: running,
    latestUserMessageAt: "2026-06-02T11:55:00.000Z",
  }),
  makeThread("asking", { hasPendingApprovals: true }),
  makeThread("settled", { settledOverride: "settled", settledAt: "2026-06-02T10:00:00.000Z" }),
  makeThread("subagent", {
    lineage: {
      rootThreadId: ThreadId.make("idle-app"),
      parentThreadId: ThreadId.make("idle-app"),
      relationshipToParent: "subagent",
    },
  }),
  makeThread("elsewhere", { environmentId: EnvironmentId.make("other") }),
];
const projects = [
  makeProject(docsProjectId, "Docs"),
  makeProject(appProjectId, "App"),
  makeProject(emptyProjectId, "Empty"),
];

function pick(input: Partial<Parameters<typeof resolveSnoozeUntilSettledPicker>[0]> = {}) {
  return resolveSnoozeUntilSettledPicker({
    threads,
    projects,
    environmentId,
    excludeThreadIds: [ThreadId.make("snoozing")],
    selectedThreadIds: [],
    query: "",
    messageMatchThreadIds: new Set(),
    projectId: null,
    status: "all",
    nowMs: NOW_MS,
    ...input,
  });
}

const ids = (picker: ReturnType<typeof pick>) => picker.rows.map((row) => row.thread.id);

describe("resolveSnoozeUntilSettledPicker", () => {
  it("lists the environment's open listed threads, working first, with their project and status", () => {
    const picker = pick();

    expect(ids(picker)).toEqual(["working-docs", "idle-app", "asking"]);
    expect(picker.rows.map((row) => row.subtitle)).toEqual([
      "Docs · Working · 5m ago",
      "App · Idle · 1h ago",
      "App · Needs attention · 1h ago",
    ]);
    expect(picker.projectOptions).toEqual([
      { id: appProjectId, title: "App" },
      { id: docsProjectId, title: "Docs" },
    ]);
    expect(picker.emptyState).toBeNull();
  });

  it("filters by project, status, title, and message hits", () => {
    expect(ids(pick({ projectId: appProjectId }))).toEqual(["idle-app", "asking"]);
    expect(ids(pick({ status: "attention" }))).toEqual(["asking"]);
    expect(ids(pick({ status: "idle" }))).toEqual(["idle-app"]);
    expect(ids(pick({ query: "docs" }))).toEqual(["working-docs"]);
    expect(
      ids(pick({ query: "migration", messageMatchThreadIds: new Set([ThreadId.make("asking")]) })),
    ).toEqual(["asking"]);
  });

  it("keeps picks that a filter hides, and drops picks that settled meanwhile", () => {
    const picker = pick({
      status: "working",
      selectedThreadIds: [ThreadId.make("asking"), ThreadId.make("settled")],
    });

    expect(ids(picker)).toEqual(["working-docs"]);
    expect(picker.selectedThreads.map((thread) => thread.id)).toEqual(["asking"]);
    expect(
      pick({ selectedThreadIds: [ThreadId.make("asking")] }).rows.map((row) => [
        row.thread.id,
        row.selected,
      ]),
    ).toEqual([
      ["asking", true],
      ["working-docs", false],
      ["idle-app", false],
    ]);
  });

  it("leaves out a thread waiting on the snoozed one through a hidden subagent", () => {
    // idle-app waits on the subagent, which waits on the snoozed thread.
    const waitsOn = new Map<string, ThreadId>([
      ["subagent", ThreadId.make("snoozing")],
      ["idle-app", ThreadId.make("subagent")],
    ]);
    const picker = pick({
      threads: threads.map((thread) => {
        const dependency = waitsOn.get(thread.id);
        if (dependency === undefined) return thread;
        return {
          ...thread,
          snoozedUntil: "2026-06-30T12:00:00.000Z",
          snoozedAt: "2026-06-02T11:00:00.000Z",
          snoozeUntilSettledThreadIds: [dependency],
        };
      }),
    });

    expect(ids(picker)).toEqual(["working-docs", "asking"]);
  });

  it("tells an environment with nothing to wait on from filters that match nothing", () => {
    expect(pick({ query: "nothing like this" }).emptyState).toBe("no-matches");
    expect(
      pick({
        excludeThreadIds: threads.map((thread) => thread.id),
      }).emptyState,
    ).toBe("no-candidates");
  });
});
