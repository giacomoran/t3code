import { type ModelProfile, MAX_MODEL_PROFILES } from "@t3tools/contracts";
import { BookmarkPlusIcon, CheckIcon, Trash2Icon } from "lucide-react";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, ComposerControlChevron } from "./ComposerControl";
import {
  isModelProfileActive,
  isModelProfileListFull,
  normalizeModelProfileName,
  suggestedModelProfileName,
  type ModelProfileSelection,
} from "../../modelProfiles";

/**
 * Trait values as short words for the suggested name — "low", "fast". Boolean
 * traits contribute their id, since `true` says nothing on its own.
 */
function traitLabelsForSelection(selection: ModelProfileSelection): ReadonlyArray<string> {
  return (selection.options ?? []).flatMap((option) => {
    if (typeof option.value === "string") return [option.value];
    return option.value ? [option.id] : [];
  });
}

/**
 * What a profile row says to the right of its name. Suggested names already
 * lead with the model, so repeating it there would just stutter; a name the
 * user typed says nothing about the setup and needs the summary.
 */
function modelProfileSummary(profile: ModelProfile): string | null {
  if (profile.name.startsWith(profile.model)) return null;
  return [profile.model, ...traitLabelsForSelection(profile)].join(" · ");
}

/**
 * One-click model setups, as a single composer control.
 *
 * The trigger names the profile the composer currently sits on, and the popup
 * both applies profiles and manages the list. Applying restores a provider
 * instance, model and every trait at once, so a combination like "Luna + low
 * reasoning + fast" is one press instead of three menus.
 */
export const ModelProfilesBar = memo(function ModelProfilesBar({
  profiles,
  selection,
  disabled = false,
  onApply,
  onSave,
  onDelete,
}: {
  profiles: ReadonlyArray<ModelProfile>;
  selection: ModelProfileSelection;
  disabled?: boolean;
  onApply: (profile: ModelProfile) => void;
  onSave: (name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [draftName, setDraftName] = useState("");

  const suggestion = suggestedModelProfileName(selection, traitLabelsForSelection(selection));
  const activeProfile =
    profiles.find((profile) => isModelProfileActive(profile, selection)) ?? null;
  const isFull = isModelProfileListFull(profiles);
  // An empty field saves under the suggested name, so the common case is
  // "open, press Save" without typing.
  const nameToSave = normalizeModelProfileName(draftName.length > 0 ? draftName : suggestion);
  const canSave = !isFull && nameToSave.length > 0;

  const save = () => {
    if (!canSave) return;
    onSave(nameToSave);
    setDraftName("");
    setIsOpen(false);
  };

  const apply = (profile: ModelProfile) => {
    onApply(profile);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger
        render={
          <ComposerControl
            type="button"
            disabled={disabled}
            data-model-profile-active={activeProfile ? "true" : undefined}
            className="shrink-0"
          >
            {profiles.length === 0 ? (
              <>
                <BookmarkPlusIcon aria-hidden="true" className="size-4" />
                <span>Save profile</span>
              </>
            ) : (
              <>
                <span className={cn("max-w-40 truncate", activeProfile && "text-foreground")}>
                  {activeProfile?.name ?? "Profiles"}
                </span>
                <ComposerControlChevron />
              </>
            )}
          </ComposerControl>
        }
      />
      <PopoverPopup align="start" className="w-72 p-1.5">
        <div className="space-y-1.5">
          {profiles.length > 0 ? (
            <ul className="space-y-0.5">
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfile?.id;
                const summary = modelProfileSummary(profile);
                return (
                  <li key={profile.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      aria-pressed={isActive}
                      data-model-profile-active={isActive ? "true" : undefined}
                      className={cn(
                        "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 text-start text-sm hover:bg-accent",
                        isActive ? "text-foreground" : "text-secondary-label",
                      )}
                      onClick={() => apply(profile)}
                    >
                      <CheckIcon
                        aria-hidden="true"
                        className={cn("size-3.5 shrink-0", isActive ? "opacity-100" : "opacity-0")}
                      />
                      <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                      {summary === null ? null : (
                        <span className="min-w-0 shrink truncate text-2xs text-muted-foreground">
                          {summary}
                        </span>
                      )}
                    </button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6 shrink-0"
                      aria-label={`Delete ${profile.name}`}
                      onClick={() => onDelete(profile.id)}
                    >
                      <Trash2Icon aria-hidden="true" className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          <div
            className={cn("space-y-1", profiles.length > 0 && "border-border/70 border-t pt-1.5")}
          >
            <p className="px-1.5 font-medium text-secondary-label text-xs">Save current setup</p>
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                className="h-7 min-w-0 flex-1 text-xs"
                maxLength={40}
                placeholder={suggestion}
                spellCheck={false}
                value={draftName}
                onChange={(event) => setDraftName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    save();
                  }
                }}
              />
              <Button
                type="button"
                size="sm"
                variant="secondary"
                className="h-7 shrink-0"
                disabled={!canSave}
                onClick={save}
              >
                Save
              </Button>
            </div>
            {isFull ? (
              <p className="px-1.5 text-2xs text-muted-foreground">
                {MAX_MODEL_PROFILES} profiles is the limit — delete one to add another.
              </p>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
