import { type ModelProfile, MAX_MODEL_PROFILES } from "@t3tools/contracts";
import { BookmarkPlusIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
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
 * One-click model setups in the composer footer.
 *
 * Each chip restores a provider instance, model and every trait at once, so a
 * combination like "Luna + low reasoning + fast" is a single press instead of
 * three menus. The trailing button manages the list: it saves whatever the
 * composer is set to right now, and deletes profiles that are no longer used.
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
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const [draftName, setDraftName] = useState("");

  const suggestion = useMemo(
    () => suggestedModelProfileName(selection, traitLabelsForSelection(selection)),
    [selection],
  );
  const activeProfileId = useMemo(
    () => profiles.find((profile) => isModelProfileActive(profile, selection))?.id ?? null,
    [profiles, selection],
  );
  const isFull = isModelProfileListFull(profiles);
  // An empty field saves under the suggested name, so the common case is
  // "open, press Save" without typing.
  const nameToSave = normalizeModelProfileName(draftName.length > 0 ? draftName : suggestion);
  const canSave = !isFull && nameToSave.length > 0;

  const save = () => {
    if (!canSave) return;
    onSave(nameToSave);
    setDraftName("");
    setIsManagerOpen(false);
  };

  return (
    <>
      {profiles.map((profile) => {
        const isActive = profile.id === activeProfileId;
        return (
          <Tooltip key={profile.id}>
            <TooltipTrigger
              render={
                <ComposerControl
                  type="button"
                  disabled={disabled}
                  aria-pressed={isActive}
                  data-model-profile-active={isActive ? "true" : undefined}
                  className={cn("shrink-0", isActive && "bg-muted text-foreground hover:bg-muted")}
                  onClick={() => onApply(profile)}
                >
                  <span className="max-w-40 truncate">{profile.name}</span>
                </ComposerControl>
              }
            />
            <TooltipPopup>
              {profile.model}
              {profile.options && profile.options.length > 0
                ? ` · ${traitLabelsForSelection(profile).join(" · ")}`
                : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}

      <Popover open={isManagerOpen} onOpenChange={setIsManagerOpen}>
        <PopoverTrigger
          render={
            <ComposerControl
              type="button"
              disabled={disabled}
              className="shrink-0 px-1.5"
              aria-label="Model profiles"
            >
              {profiles.length === 0 ? (
                <>
                  <BookmarkPlusIcon aria-hidden="true" className="size-4" />
                  <span>Save profile</span>
                </>
              ) : (
                <PlusIcon aria-hidden="true" className="size-4" />
              )}
            </ComposerControl>
          }
        />
        <PopoverPopup align="start" className="w-72 p-2">
          <div className="space-y-2">
            <div className="space-y-1">
              <p className="font-medium text-xs text-secondary-label">Save current setup</p>
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
                <p className="text-[11px] text-muted-foreground">
                  {MAX_MODEL_PROFILES} profiles is the limit — delete one to add another.
                </p>
              ) : null}
            </div>

            {profiles.length > 0 ? (
              <div className="space-y-1 border-border/70 border-t pt-2">
                <p className="font-medium text-xs text-secondary-label">Profiles</p>
                <ul className="space-y-0.5">
                  {profiles.map((profile) => (
                    <li key={profile.id} className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs">{profile.name}</span>
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground">
                        {profile.model}
                      </span>
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
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
    </>
  );
});
