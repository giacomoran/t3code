import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  moveHighlightedThreadKey,
  presentSnoozeUntilSettled,
  resolveSnoozeUntilSettledKey,
  snoozeUntilSettledProjectOptions,
} from "./snoozeUntilSettled.logic";

const first = ThreadId.make("thread-first");
const second = ThreadId.make("thread-second");
const third = ThreadId.make("thread-third");

describe("resolveSnoozeUntilSettledKey", () => {
  const base = {
    isComposing: false,
    query: "",
    isNavigating: false,
    hasHighlight: true,
    selectedCount: 0,
  };

  it.each([
    { name: "arrows move", input: { key: "ArrowDown" }, expected: "move-down" },
    { name: "arrows move up", input: { key: "ArrowUp" }, expected: "move-up" },
    { name: "Space toggles with nothing typed", input: { key: " " }, expected: "toggle" },
    {
      name: "Space types into a query",
      input: { key: " ", query: "fix" },
      expected: null,
    },
    {
      name: "Space toggles after moving with the arrows",
      input: { key: " ", query: "fix", isNavigating: true },
      expected: "toggle",
    },
    {
      name: "Space without a highlighted row types",
      input: { key: " ", hasHighlight: false },
      expected: null,
    },
    {
      name: "Enter confirms the picked threads",
      input: { key: "Enter", selectedCount: 2 },
      expected: "confirm",
    },
    {
      name: "Enter with nothing picked takes the highlighted thread",
      input: { key: "Enter" },
      expected: "toggle-and-confirm",
    },
    {
      name: "Enter with nothing to take does nothing",
      input: { key: "Enter", hasHighlight: false },
      expected: null,
    },
    {
      name: "keys finishing an IME composition are the composer's",
      input: { key: "Enter", isComposing: true, selectedCount: 1 },
      expected: null,
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveSnoozeUntilSettledKey({ ...base, ...input })).toBe(expected);
  });
});

describe("moveHighlightedThreadKey", () => {
  it.each([
    { highlighted: null, direction: "down", expected: first },
    { highlighted: first, direction: "down", expected: second },
    { highlighted: third, direction: "down", expected: third },
    { highlighted: first, direction: "up", expected: first },
    { highlighted: "filtered-out", direction: "up", expected: first },
  ] as const)(
    "moves $direction from $highlighted to $expected",
    ({ highlighted, direction, expected }) => {
      expect(moveHighlightedThreadKey([first, second, third], highlighted, direction)).toBe(
        expected,
      );
    },
  );
});

describe("snoozeUntilSettledProjectOptions", () => {
  it("lists each project with a listable thread once, by title, skipping unloaded projects", () => {
    const here = EnvironmentId.make("here");
    const box = EnvironmentId.make("box");
    const beta = ProjectId.make("beta");
    const alpha = ProjectId.make("alpha");
    const unloaded = ProjectId.make("unloaded");
    const titles = new Map([
      [beta, "Beta"],
      [alpha, "alpha"],
    ]);
    expect(
      snoozeUntilSettledProjectOptions(
        [
          { environmentId: here, projectId: beta },
          { environmentId: here, projectId: alpha },
          { environmentId: here, projectId: beta },
          { environmentId: here, projectId: unloaded },
          // The same id on another machine is another project.
          { environmentId: box, projectId: beta },
        ],
        (thread) => titles.get(thread.projectId) ?? null,
      ),
    ).toEqual([
      { project: { environmentId: here, projectId: alpha }, title: "alpha" },
      { project: { environmentId: here, projectId: beta }, title: "Beta" },
      { project: { environmentId: box, projectId: beta }, title: "Beta" },
    ]);
  });
});

describe("presentSnoozeUntilSettled", () => {
  const environmentId = EnvironmentId.make("environment");
  const otherEnvironmentId = EnvironmentId.make("other-environment");
  const now = "2026-11-19T12:00:00.000Z";
  const waiter = (
    threadIds: ReadonlyArray<ThreadId> | null,
    linkedThreads: ReadonlyArray<{ environmentId: EnvironmentId; threadId: ThreadId }> = [],
  ) => ({
    environmentId,
    snoozedUntil: "2026-12-19T12:00:00.000Z",
    snoozedAt: "2026-11-19T11:00:00.000Z",
    snoozeUntilSettledThreadIds: threadIds,
    snoozeUntilSettledLinkedThreads: linkedThreads,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  });
  const loaded = new Set([environmentId, otherEnvironmentId]);
  const shell = (
    id: ThreadId,
    overrides: { environmentId?: EnvironmentId; settled?: boolean; archived?: boolean } = {},
  ) => ({
    id,
    environmentId: overrides.environmentId ?? environmentId,
    title: `Title ${id}`,
    settledOverride: overrides.settled ? ("settled" as const) : null,
    settledAt: overrides.settled ? now : null,
    archivedAt: overrides.archived ? now : null,
  });

  it("is null for a time snooze", () => {
    expect(
      presentSnoozeUntilSettled(waiter(null), {
        now,
        shells: { shells: [], loadedEnvironmentIds: loaded },
      }),
    ).toBeNull();
  });

  it("lists the loaded threads of the waiter's environment in pick order", () => {
    expect(
      presentSnoozeUntilSettled(waiter([third, first, second]), {
        now,
        shells: {
          shells: [
            shell(first, { settled: true }),
            shell(second, { archived: true }),
            // Same id in another environment is a different thread.
            shell(third, { environmentId: otherEnvironmentId }),
          ],
          loadedEnvironmentIds: loaded,
        },
      }),
    ).toEqual({
      threadCount: 3,
      waitingCount: 3,
      waitingOn: [
        {
          ref: { environmentId, threadId: first },
          title: "Title thread-first",
          isSettled: true,
          isLinked: false,
        },
        {
          ref: { environmentId, threadId: second },
          title: "Title thread-second",
          isSettled: true,
          isLinked: false,
        },
      ],
      wokeLabel: null,
    });
  });

  it("lists linked threads after the ones here, counting those it cannot see", () => {
    const unseenEnvironmentId = EnvironmentId.make("unseen-environment");
    expect(
      presentSnoozeUntilSettled(
        waiter(
          [first],
          [
            { environmentId: otherEnvironmentId, threadId: third },
            { environmentId: unseenEnvironmentId, threadId: second },
          ],
        ),
        {
          now,
          shells: {
            shells: [shell(first), shell(third, { environmentId: otherEnvironmentId })],
            loadedEnvironmentIds: loaded,
          },
        },
      ),
    ).toEqual({
      threadCount: 3,
      waitingCount: 3,
      waitingOn: [
        {
          ref: { environmentId, threadId: first },
          title: "Title thread-first",
          isSettled: false,
          isLinked: false,
        },
        {
          ref: { environmentId: otherEnvironmentId, threadId: third },
          title: "Title thread-third",
          isSettled: false,
          isLinked: true,
        },
      ],
      wokeLabel: null,
    });
  });
});
