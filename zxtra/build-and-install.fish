#!/usr/bin/env fish
#
# Build this fork and install it over /Applications/T3 Code (Beta).app.
#
# Run it after rebasing onto upstream. Everything here exists because a plain
# `pnpm dist:desktop:dmg:arm64` is not enough on this machine — see the notes
# beside each step.

set --local repo (cd (dirname (status filename))/..; and pwd)
cd $repo; or exit 1

set --local app_name "T3 Code (Beta).app"
set --local installed "/Applications/$app_name"
# Upstream renamed the app from "(Alpha)" to "(Beta)" in v0.1.0. Both share the
# bundle id and data directory, so an Alpha copy is backed up on install like
# the app it replaces, instead of lingering beside it as a second launcher.
set --local installed_legacy "/Applications/T3 Code (Alpha).app"

# ── Toolchain ────────────────────────────────────────────────────────────────
# Node and Rust are pinned in .tool-versions, which is deliberately kept out of
# the fork's git diff, so a fresh clone has to be told again. Rust must be
# >= 1.95: the native resource monitor depends on a sysinfo that refuses older
# compilers.
set --local node_bin "$HOME/.asdf/installs/nodejs/24.19.0/bin"
set --local rust_home "$HOME/.asdf/installs/rust/1.98.0"
for dir in $node_bin $rust_home/bin
    if not test -d $dir
        echo "missing toolchain: $dir"
        echo "install it with asdf, then re-run (see ZXTRA.md → Toolchain)."
        exit 1
    end
end
set --export PATH $rust_home/bin $node_bin $PATH
set --export RUSTUP_HOME $rust_home
set --export CARGO_HOME $rust_home

# ~/.cargo/config.toml sets a relative `target-dir`, which cargo resolves
# against the home directory — so the resource monitor builds into ~/target and
# the packaging step then fails to find it. Pin the target dir for this build
# only; the global config stays untouched.
set --export CARGO_TARGET_DIR $repo/native/resource-monitor/target

# No Apple signing identity on this machine, so stop electron-builder from
# hunting for one. The bundle is ad-hoc signed further down instead.
set --export CSC_IDENTITY_AUTO_DISCOVERY false

# T3 Connect's public configuration, which upstream's release workflow injects.
# Without it the app hides T3 Connect sign-in and its server has no `t3 connect`.
for line in (string match --invert --regex '^\s*(#|$)' < $repo/zxtra/t3-connect.env)
    set --local entry (string split --max 1 = $line)
    set --export $entry[1] $entry[2]
end

# pgrep takes a regex; the dots stand in for the parentheses in the app name.
if test (count (pgrep -f 'T3 Code .(Alpha|Beta)..app/Contents/')) -gt 0
    echo "note: T3 Code is running — quit it before launching the new build."
end

# ── Build ────────────────────────────────────────────────────────────────────
echo "==> building (a few minutes)"
pnpm dist:desktop:dmg:arm64; or exit 1

set --local zip (ls -t $repo/release/T3-Code-*-arm64.zip 2>/dev/null)[1]
if not test -f "$zip"
    echo "no build artifact in release/"
    exit 1
end

# ── Stage and sign ───────────────────────────────────────────────────────────
# electron-builder leaves an invalid ad-hoc signature ("code has no resources
# but signature indicates they must be present"), which macOS refuses to
# launch on arm64. Re-signing the staged copy fixes it.
set --local stage (mktemp -d)
echo "==> staging from "(basename $zip)
ditto -xk "$zip" $stage; or exit 1
set --local built "$stage/$app_name"
test -d "$built"; or begin; echo "no $app_name inside the zip"; exit 1; end

echo "==> signing"
codesign --force --deep --sign - "$built"; or exit 1
codesign --verify --deep "$built"; or begin; echo "signature still invalid"; exit 1; end

# ── Sanity-check the bundle really is the fork ───────────────────────────────
for marker in font-size-chat katex quota_reserve
    if not grep -qa $marker "$built/Contents/Resources/app.asar"
        echo "built bundle is missing '$marker' — refusing to install"
        exit 1
    end
end
if not grep -qa $T3CODE_RELAY_URL "$built/Contents/Resources/app.asar"
    echo "built bundle is missing the T3 Connect relay URL — refusing to install"
    exit 1
end

# The release build ships an app-update.yml pointing at pingdotgg/t3code. A
# local build has no publish config and so no feed, which is what keeps an
# upstream release from replacing this fork. Verify rather than assume.
if test -f "$built/Contents/Resources/app-update.yml"
    echo "built bundle has an update feed — it could overwrite itself with upstream:"
    cat "$built/Contents/Resources/app-update.yml"
    exit 1
end

# ── Install ──────────────────────────────────────────────────────────────────
set --local stamp (date +%Y%m%d-%H%M%S)
if test -d "$installed"
    echo "==> backing up current app"
    mv "$installed" "/Applications/$app_name.$stamp.bak"; or exit 1
end
if test -d "$installed_legacy"
    echo "==> backing up the pre-rename Alpha app"
    mv "$installed_legacy" "$installed_legacy.$stamp.bak"; or exit 1
end
echo "==> installing"
ditto "$built" "$installed"; or exit 1
rm -rf $stage

echo
echo "installed: $installed"
echo "previous:  /Applications/$app_name.$stamp.bak  (delete when happy, ~400MB)"
echo
echo "Quit T3 Code fully (Cmd-Q) and relaunch."
echo "Confirm the fork: Settings → Appearance shows 'Chat font size' and 'Math (LaTeX) in chat'."
