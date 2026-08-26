import { ProviderInstanceId, type ModelProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addModelProfile,
  createModelProfile,
  findActiveModelProfile,
  isModelProfileActive,
  removeModelProfile,
  renameModelProfile,
  reorderModelProfiles,
  suggestedModelProfileName,
} from "./modelProfiles";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");

function profile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "profile-1",
    name: "Luna fast",
    instanceId: codex,
    model: "gpt-5.6-luna",
    options: [
      { id: "reasoningEffort", value: "low" },
      { id: "fastMode", value: true },
    ],
    ...overrides,
  };
}

/** The same profile with no traits at all, which is a distinct setup. */
function profileWithoutOptions(overrides: Partial<ModelProfile> = {}): ModelProfile {
  const { options: _options, ...rest } = profile(overrides);
  return rest;
}

describe("isModelProfileActive", () => {
  it("matches a selection with the same traits in a different order", () => {
    expect(
      isModelProfileActive(profile(), {
        instanceId: codex,
        model: "gpt-5.6-luna",
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "low" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects a selection that differs only by a trait value", () => {
    expect(
      isModelProfileActive(profile(), {
        instanceId: codex,
        model: "gpt-5.6-luna",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a selection carrying an extra trait", () => {
    expect(
      isModelProfileActive(profile(), {
        instanceId: codex,
        model: "gpt-5.6-luna",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: true },
          { id: "webSearch", value: true },
        ],
      }),
    ).toBe(false);
  });

  it("rejects the same model on a different provider instance", () => {
    expect(
      isModelProfileActive(profileWithoutOptions(), {
        instanceId: claude,
        model: "gpt-5.6-luna",
      }),
    ).toBe(false);
  });

  it("treats an absent options list and an empty one as the same setup", () => {
    expect(
      isModelProfileActive(profileWithoutOptions(), {
        instanceId: codex,
        model: "gpt-5.6-luna",
        options: [],
      }),
    ).toBe(true);
  });
});

describe("findActiveModelProfile", () => {
  it("returns null when nothing matches", () => {
    const found = findActiveModelProfile([profile()], {
      instanceId: codex,
      model: "gpt-5.6-sol",
    });

    expect(found).toBeNull();
  });
});

describe("createModelProfile", () => {
  it("captures the selection and assigns an id", () => {
    const created = createModelProfile("Luna fast", {
      instanceId: codex,
      model: "gpt-5.6-luna",
      options: [{ id: "fastMode", value: true }],
    });

    expect(created.id.length).toBeGreaterThan(0);
    expect(created.name).toBe("Luna fast");
    expect(created.model).toBe("gpt-5.6-luna");
    expect(created.options).toEqual([{ id: "fastMode", value: true }]);
  });

  it("omits options entirely when the selection has none", () => {
    const created = createModelProfile("Plain", { instanceId: codex, model: "gpt-5.6-sol" });

    expect(created.options).toBeUndefined();
  });

  it("refuses a blank name", () => {
    expect(() => createModelProfile("   ", { instanceId: codex, model: "gpt-5.6-sol" })).toThrow();
  });
});

describe("suggestedModelProfileName", () => {
  it("joins the model with its trait labels", () => {
    const name = suggestedModelProfileName({ instanceId: codex, model: "gpt-5.6-luna" }, [
      "Low",
      "Fast",
    ]);

    expect(name).toBe("gpt-5.6-luna · Low · Fast");
  });
});

describe("model profile list edits", () => {
  it("adds, renames, and removes by id", () => {
    const first = profile({ id: "a", name: "A" });
    const second = profile({ id: "b", name: "B" });

    const added = addModelProfile([first], second);
    expect(added.map((entry) => entry.id)).toEqual(["a", "b"]);

    const renamed = renameModelProfile(added, "b", "B2");
    expect(renamed[1]?.name).toBe("B2");

    expect(removeModelProfile(renamed, "a").map((entry) => entry.id)).toEqual(["b"]);
  });

  it("reorders a profile to a new index", () => {
    const profiles = [profile({ id: "a" }), profile({ id: "b" }), profile({ id: "c" })];

    expect(reorderModelProfiles(profiles, "c", 0).map((entry) => entry.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("leaves the list alone when the id is unknown", () => {
    const profiles = [profile({ id: "a" })];

    expect(reorderModelProfiles(profiles, "missing", 0)).toBe(profiles);
  });
});
