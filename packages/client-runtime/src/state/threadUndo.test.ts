import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { executeThreadUndo, planThreadUndo, type ThreadUndoStep } from "./threadUndo.ts";

const NOW = "2026-11-19T12:00:00.000Z";
const CAP = "2026-12-18T12:00:00.000Z";
const first = ThreadId.make("thread-first");
const onBox = { environmentId: EnvironmentId.make("environment-box"), threadId: first };

describe("planThreadUndo", () => {
  it("restores the threads a cleared snooze waited on", () => {
    expect(
      planThreadUndo("unpin", {
        pinnedAt: NOW,
        pinOrderKey: "a0",
        snoozedUntil: CAP,
        snoozeUntilSettledThreadIds: [first],
        snoozeUntilSettledLinkedThreads: [onBox],
      }),
    ).toEqual([
      { action: "pin", orderKey: "a0" },
      {
        action: "snooze",
        snoozedUntil: CAP,
        untilSettledThreadIds: [first],
        untilSettledLinkedThreads: [onBox],
      },
    ]);
  });
});

describe("executeThreadUndo", () => {
  // Far ahead, so the restore is never skipped as an expired time.
  const LATER = "2099-01-01T00:00:00.000Z";

  it.each([
    {
      name: "restores a wait whose threads are still open",
      done: false,
      linked: false,
      restored: true,
    },
    {
      name: "skips a wait whose threads all finished meanwhile",
      done: true,
      linked: false,
      restored: false,
    },
    // The server cannot check linked threads when deciding, so it takes the wait.
    { name: "restores a wait on linked threads too", done: true, linked: true, restored: true },
  ])("$name", async ({ done, linked, restored }) => {
    const executed: Array<ThreadUndoStep["action"]> = [];
    await executeThreadUndo(
      [
        { action: "unsettle" },
        {
          action: "snooze",
          snoozedUntil: LATER,
          untilSettledThreadIds: [first],
          ...(linked ? { untilSettledLinkedThreads: [onBox] } : {}),
        },
      ],
      async (step) => {
        executed.push(step.action);
        return true;
      },
      (result) => result,
      () => done,
    );
    expect(executed).toEqual(restored ? ["unsettle", "snooze"] : ["unsettle"]);
  });
});
