#!/usr/bin/env fish
#
# Pre-flight for an upstream update. Gathers evidence, does not change anything.
#
# A rebase that applies cleanly is not the same as a rebase that still works.
# The fork reads upstream fields and calls upstream helpers; a rename upstream
# produces no conflict and no type error in the files it touched — the feature
# just stops doing anything. This checks those load-bearing assumptions
# explicitly, so the review is about judgement rather than remembering what to
# grep for.
#
# Override the compared ref with ZXTRA_UPSTREAM_REF (useful for dry runs).

set --local repo (cd (dirname (status filename))/..; and pwd)
cd $repo; or exit 1

set --local ref $ZXTRA_UPSTREAM_REF
test -n "$ref"; or set ref upstream/main

echo "==> fetching upstream"
git fetch upstream --quiet 2>/dev/null
git rev-parse --verify --quiet $ref >/dev/null; or begin
    echo "no such ref: $ref"
    exit 1
end

set --local base (git merge-base HEAD $ref)
set --local ahead (git rev-list --count $base..$ref)

echo
echo "──────── 1. what upstream has done since the fork point ────────"
echo "comparing HEAD against $ref"
echo "new upstream commits: $ahead"
if test $ahead -eq 0
    echo "nothing new to pull; checking assumptions against $ref anyway."
end
echo "span: "(git log -1 --format=%as $base)" → "(git log -1 --format=%as $ref)
echo
echo "areas touched (top 12 directories):"
git diff --name-only $base..$ref | awk -F/ '{ if (NF>=3) print $1"/"$2"/"$3; else print $0 }' \
    | sort | uniq -c | sort -rn | head -12

echo
echo "──────── 2. collision risk: upstream edits to files the fork also edits ────────"
# Only the files the fork actually modifies can conflict. Files the fork adds
# are listed separately below, where the risk is upstream creating the same path.
set --local fork_files (git diff --name-only $base..HEAD)
# One diff for the whole upstream span, then intersect. Asking git per file
# costs a full revision walk each time, which is minutes on a long span.
set --local upstream_files (git diff --name-only $base..$ref)
set --local touched 0
for file in $fork_files
    if not git cat-file -e $base:$file 2>/dev/null
        continue # fork-added file, handled in section 3
    end
    if not contains -- $file $upstream_files
        continue
    end
    set touched (math $touched + 1)
    echo
    echo "  $file"
    git log --format="      %h %s" $base..$ref -- $file | head -4
end
if test $touched -eq 0
    echo "  none — no textual conflicts expected."
end

echo
echo "──────── 3. path collisions with files the fork adds ────────"
set --local collided 0
for file in $fork_files
    if git cat-file -e $base:$file 2>/dev/null
        continue
    end
    if git cat-file -e $ref:$file 2>/dev/null
        echo "  COLLISION: upstream now also has $file"
        set collided (math $collided + 1)
    end
end
if test $collided -eq 0
    echo "  none."
end

echo
echo "──────── 4. load-bearing assumptions ────────"
echo "each is something the fork reads or calls; a miss is a silent breakage."
set --local missing 0
# feature :: what it holds up :: path in the upstream tree :: pattern
for row in \
    "font   :: chat transcript class the size hook attaches to :: apps/web/src/components/ChatMarkdown.tsx :: chat-markdown" \
    "font   :: code blocks pinned to their own size, not chat  :: apps/web/src/index.css :: --font-size-code" \
    "font   :: root font-variable applier                      :: apps/web/src/appearanceFonts.ts :: applyAppearanceFontVariables" \
    "settings:: client schema the new settings extend          :: packages/contracts/src/settings.ts :: ClientSettingsSchema" \
    "settings:: patch schema (a field missing here is dropped)  :: packages/contracts/src/settings.ts :: ClientSettingsPatch" \
    "settings:: defaults derived from the schema               :: packages/contracts/src/settings.ts :: DEFAULT_UNIFIED_SETTINGS" \
    "profile:: applying a profile as a complete snapshot       :: apps/web/src/composerDraftStore.ts :: replaceOptions" \
    "profile:: model-change guards a profile routes through    :: apps/web/src/components/ChatView.tsx :: onProviderModelSelect" \
    "profile:: trait payload stored in a profile               :: packages/contracts/src/model.ts :: ProviderOptionSelections" \
    "profile:: client-settings writer the composer uses        :: apps/web/src/hooks/useSettings.ts :: updateClientSettings" \
    "list   :: marker parser the list-start check reuses       :: apps/web/src/composer-list-continuation.ts :: parseListMarker" \
    "quota  :: pre-start failure path the gate reuses          :: apps/server/src/orchestration-v2/ProviderTurnStartService.ts :: settleRunBeforeStart" \
    "quota  :: blocked prompt replayed on the next start       :: apps/server/src/orchestration-v2/ProviderTurnStartService.ts :: missedRuns" \
    "quota  :: registry the turn tracker decorates             :: apps/server/src/orchestration-v2/ProviderAdapterRegistry.ts :: layerFromProviderInstanceRegistry" \
    "quota  :: usage-limit state a reserve stop must match     :: packages/shared/src/orchestrationV2ThreadError.ts :: usageLimitBlockedRun" \
    "quota  :: Continue on a stopped run (authorizes reserve)  :: apps/server/src/orchestration-v2/Orchestrator.ts :: manualContinuationOfRunId" \
    "quota  :: auto-resume at reset                            :: apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts :: usageLimitContinuationOfRunId" \
    "quota  :: Claude streams limits into the shared snapshot  :: apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts :: onUsageLimits" \
    "quota  :: Codex streams limits into the shared snapshot   :: apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts :: onUsageLimits"
    set --local parts (string split "::" -- $row)
    set --local feature (string trim -- $parts[1])
    set --local why (string trim -- $parts[2])
    set --local path (string trim -- $parts[3])
    set --local pattern (string trim -- $parts[4])
    if git grep -q -- $pattern $ref -- $path 2>/dev/null
        printf "  ok      %-8s %s\n" $feature $pattern
    else
        printf "  MISSING %-8s %s\n" $feature $pattern
        printf "          in %s\n" $path
        printf "          holds up: %s\n" $why
        set missing (math $missing + 1)
    end
end

echo
echo "──────── 5. did upstream build any of this themselves? ────────"
echo "a hit means the fork's patch may now be redundant, or may collide in behaviour."
for row in \
    "chat font size :: fontSizeChat" \
    "model profiles :: modelProfiles"
    set --local parts (string split "::" -- $row)
    set --local label (string trim -- $parts[1])
    set --local pattern (string trim -- $parts[2])
    set --local hits (git grep -l -F -- $pattern $ref -- apps/web/src packages/contracts/src 2>/dev/null | wc -l | string trim)
    if test "$hits" != "0"
        echo "  upstream now mentions '$pattern' ($label) in $hits file(s):"
        git grep -l -F -- $pattern $ref -- apps/web/src packages/contracts/src 2>/dev/null | head -4 | sed 's/^/      /'
    else
        echo "  no sign of $label upstream"
    end
end

echo
echo "──────── verdict ────────"
if test $missing -gt 0
    echo "$missing load-bearing assumption(s) gone — DO NOT rebase blind."
    echo "Read section 4, find what replaced each one, and plan the fix first."
    exit 2
end
if test $collided -gt 0
    echo "$collided path collision(s) — upstream added a file the fork also adds."
    exit 2
end
echo "assumptions intact. $touched fork-touched file(s) saw upstream edits."
if test $touched -gt 0
    echo "expect textual conflicts there; the fork's hunks are small and listed in ZXTRA.md."
end
echo "safe to proceed: git rebase upstream/main zxtra; and pnpm tc; and ./zxtra/build-and-install.fish"
