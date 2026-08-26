/**
 * Model profiles: named snapshots of a composer model setup (provider
 * instance + model + traits) that apply in one click.
 *
 * The logic here is deliberately pure so the composer chips and the settings
 * list agree on what "the active profile" means without either owning it.
 */

import {
  MAX_MODEL_PROFILES,
  MODEL_PROFILE_NAME_MAX_LENGTH,
  ProviderInstanceId,
  type ModelProfile,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { randomUUID } from "./lib/utils";

export interface ModelProfileSelection {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}

/**
 * Traits keyed by id, so two selections that list the same traits in a
 * different order still compare equal. Providers hand descriptors back in
 * whatever order they declare them, which is not stable across models.
 */
function traitsById(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
): Map<string, string | boolean> {
  const byId = new Map<string, string | boolean>();
  for (const option of options ?? []) {
    byId.set(option.id, option.value);
  }
  return byId;
}

function sameTraits(
  left: ReadonlyArray<ProviderOptionSelection> | undefined,
  right: ReadonlyArray<ProviderOptionSelection> | undefined,
): boolean {
  const leftById = traitsById(left);
  const rightById = traitsById(right);
  if (leftById.size !== rightById.size) return false;
  for (const [id, value] of leftById) {
    if (rightById.get(id) !== value) return false;
  }
  return true;
}

/** Whether the composer currently sits on exactly this profile. */
export function isModelProfileActive(
  profile: ModelProfile,
  selection: ModelProfileSelection,
): boolean {
  return (
    profile.instanceId === selection.instanceId &&
    profile.model === selection.model &&
    sameTraits(profile.options, selection.options)
  );
}

export function findActiveModelProfile(
  profiles: ReadonlyArray<ModelProfile>,
  selection: ModelProfileSelection,
): ModelProfile | null {
  return profiles.find((profile) => isModelProfileActive(profile, selection)) ?? null;
}

/**
 * Trim to what the name field accepts. Empty input has no sensible default —
 * the caller decides whether to reject or fall back to a derived label.
 */
export function normalizeModelProfileName(name: string): string {
  return name.trim().slice(0, MODEL_PROFILE_NAME_MAX_LENGTH);
}

/**
 * A starting label for a new profile: the model, plus each trait value that
 * is set. Matches how the composer already summarizes a setup, so the
 * suggested name reads like the controls it came from.
 */
export function suggestedModelProfileName(
  selection: ModelProfileSelection,
  traitLabels: ReadonlyArray<string> = [],
): string {
  const parts = [selection.model, ...traitLabels].filter((part) => part.trim().length > 0);
  return normalizeModelProfileName(parts.join(" · "));
}

export function createModelProfile(name: string, selection: ModelProfileSelection): ModelProfile {
  const normalized = normalizeModelProfileName(name);
  if (normalized.length === 0) {
    throw new Error("A model profile needs a name");
  }
  return {
    id: randomUUID(),
    name: normalized,
    instanceId: selection.instanceId,
    model: selection.model,
    ...(selection.options && selection.options.length > 0
      ? { options: selection.options.map((option) => ({ ...option })) }
      : {}),
  };
}

/** True once the list is full; the caller surfaces why the add is refused. */
export function isModelProfileListFull(profiles: ReadonlyArray<ModelProfile>): boolean {
  return profiles.length >= MAX_MODEL_PROFILES;
}

export function addModelProfile(
  profiles: ReadonlyArray<ModelProfile>,
  profile: ModelProfile,
): ReadonlyArray<ModelProfile> {
  if (isModelProfileListFull(profiles)) {
    throw new Error(`At most ${MAX_MODEL_PROFILES} model profiles are supported`);
  }
  return [...profiles, profile];
}

export function removeModelProfile(
  profiles: ReadonlyArray<ModelProfile>,
  id: string,
): ReadonlyArray<ModelProfile> {
  return profiles.filter((profile) => profile.id !== id);
}

export function renameModelProfile(
  profiles: ReadonlyArray<ModelProfile>,
  id: string,
  name: string,
): ReadonlyArray<ModelProfile> {
  const normalized = normalizeModelProfileName(name);
  if (normalized.length === 0) {
    throw new Error("A model profile needs a name");
  }
  return profiles.map((profile) =>
    profile.id === id ? { ...profile, name: normalized } : profile,
  );
}

/**
 * Move a profile to a new index, clamped to the list. Used by the settings
 * list to reorder the chips the composer renders left to right.
 */
export function reorderModelProfiles(
  profiles: ReadonlyArray<ModelProfile>,
  id: string,
  toIndex: number,
): ReadonlyArray<ModelProfile> {
  const fromIndex = profiles.findIndex((profile) => profile.id === id);
  const moved = profiles[fromIndex];
  if (fromIndex === -1 || moved === undefined) return profiles;
  const target = Math.min(Math.max(toIndex, 0), profiles.length - 1);
  if (target === fromIndex) return profiles;
  const next = profiles.filter((profile) => profile.id !== id);
  next.splice(target, 0, moved);
  return next;
}
