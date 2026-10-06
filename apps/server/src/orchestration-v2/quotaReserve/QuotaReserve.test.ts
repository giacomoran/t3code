import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { evaluateQuotaReserve } from "./QuotaReserve.ts";

const nowMs = Date.parse("2026-10-06T10:00:00.000Z");
const futureReset = "2026-10-06T12:00:00.000Z";

function limits(input?: {
  readonly usedPercent?: number;
  readonly resetsAt?: string;
  readonly unavailable?: ServerProviderUsageLimits["unavailable"];
  readonly includeWindow?: boolean;
}): ServerProviderUsageLimits {
  return {
    checkedAt: "2026-10-06T09:59:00.000Z",
    windows:
      input?.includeWindow === false
        ? []
        : [
            {
              id: "five_hour",
              kind: "session",
              label: "Five hour",
              usedPercent: input?.usedPercent ?? 90,
              ...(input?.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
            },
          ],
    ...(input?.unavailable === undefined ? {} : { unavailable: input.unavailable }),
  };
}

describe("evaluateQuotaReserve", () => {
  it("allows work when the reserve is disabled", () => {
    assert.deepEqual(
      evaluateQuotaReserve({
        limits: undefined,
        percentReserve: 0,
        nowMs,
        authorizedUntil: undefined,
      }),
      { type: "allow" },
    );
  });

  it.each([
    ["missing limits", undefined],
    ["provider unavailable", limits({ unavailable: { reason: "probeFailed" } })],
    ["missing five-hour window", limits({ includeWindow: false })],
    ["missing reset", limits()],
    ["expired reset", limits({ resetsAt: "2026-10-06T09:00:00.000Z" })],
  ])("allows work when the reading is unavailable: %s", (_name, usageLimits) => {
    assert.deepEqual(
      evaluateQuotaReserve({
        limits: usageLimits,
        percentReserve: 10,
        nowMs,
        authorizedUntil: undefined,
      }),
      { type: "allow_unavailable" },
    );
  });

  it("allows usage below the threshold", () => {
    assert.deepEqual(
      evaluateQuotaReserve({
        limits: limits({ usedPercent: 89, resetsAt: futureReset }),
        percentReserve: 10,
        nowMs,
        authorizedUntil: undefined,
      }),
      { type: "allow" },
    );
  });

  it("blocks usage at the threshold", () => {
    assert.deepEqual(
      evaluateQuotaReserve({
        limits: limits({ usedPercent: 91, resetsAt: futureReset }),
        percentReserve: 10,
        nowMs,
        authorizedUntil: undefined,
      }),
      { type: "block", resetsAt: futureReset, usedPercent: 91 },
    );
  });

  it("recognizes Codex's 300-minute primary window", () => {
    const usageLimits = limits({ usedPercent: 91, resetsAt: futureReset });
    const primaryWindow = usageLimits.windows[0]!;
    assert.equal(
      evaluateQuotaReserve({
        limits: {
          ...usageLimits,
          windows: [{ ...primaryWindow, id: "primary", windowDurationMins: 300 }],
        },
        percentReserve: 10,
        nowMs,
        authorizedUntil: undefined,
      }).type,
      "block",
    );
  });

  it("allows only an unexpired authorization", () => {
    const usageLimits = limits({ usedPercent: 91, resetsAt: futureReset });
    assert.equal(
      evaluateQuotaReserve({
        limits: usageLimits,
        percentReserve: 10,
        nowMs,
        authorizedUntil: futureReset,
      }).type,
      "allow",
    );
    assert.equal(
      evaluateQuotaReserve({
        limits: usageLimits,
        percentReserve: 10,
        nowMs,
        authorizedUntil: "2026-10-06T09:00:00.000Z",
      }).type,
      "block",
    );
  });
});
