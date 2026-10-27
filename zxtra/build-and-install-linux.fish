#!/usr/bin/env fish
#
# Build this fork as a self-contained `t3` CLI and install it as the T3 Code
# service on this Linux machine. The Linux counterpart of build-and-install.fish,
# which builds the macOS desktop app; the desktop app and this server must come
# from the same fork, or the app refuses to connect ("Client not supported").
#
# It follows the steps upstream's release workflow uses for the Linux CLI
# archive, then unpacks the archive where `t3 service install` looks for a
# pinned runtime, so the service runs the fork instead of downloading a release.

set --local repo (cd (dirname (status filename))/..; and pwd)
cd $repo; or exit 1

# ── Toolchain ────────────────────────────────────────────────────────────────
# Node, Rust and pnpm come from .tool-versions and packageManager via mise. Rust
# must be >= 1.95: the native resource monitor depends on a sysinfo that refuses
# older compilers.
for tool in mise node pnpm cargo rustc
    if not type -q $tool
        echo "missing toolchain: $tool (see ZXTRA.md → Toolchain)"
        exit 1
    end
end
# Upstream's build scripts call `vp` (Vite+) by name. CI installs it globally;
# here it comes from the repo's own dependencies.
set --export PATH $repo/node_modules/.bin $PATH

set --local rust_minor (rustc --version | string match -r '^rustc 1\.(\d+)')[2]
if test "$rust_minor" -lt 95
    echo "rustc 1.$rust_minor is too old; the resource monitor needs >= 1.95"
    exit 1
end

# T3 Connect's public configuration, which upstream's release workflow injects.
# Without it `t3 connect` is a stub, so the server cannot link to T3 Connect and
# the mobile app gets no push notifications.
for line in (string match --invert --regex '^\s*(#|$)' < $repo/zxtra/t3-connect.env)
    set --local entry (string split --max 1 = $line)
    set --export $entry[1] $entry[2]
end

# ── Version ──────────────────────────────────────────────────────────────────
# The service keys its runtime folder and `activeVersion` on the version the
# binary reports, so the fork needs its own: upstream's version plus the fork
# commit. That keeps the official runtime untouched beside it as a fallback.
if test -n "$(git status --porcelain --untracked-files=no)"
    echo "working tree is dirty — commit or stash first, so the version names a real commit"
    git status --short
    exit 1
end
set --local base_version (node -p 'require("./apps/server/package.json").version')
set --local build_version "$base_version-zxtra.g"(git rev-parse --short HEAD)
set --local release_manifests apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json
echo "==> building t3 $build_version"

# Stamp the version into the release manifests, as upstream's CI does, and put
# them back however the build ends.
function restore_release_manifests --inherit-variable release_manifests
    git checkout -- $release_manifests
end
node scripts/update-release-package-versions.ts $build_version; or begin; restore_release_manifests; exit 1; end

# ── Build ────────────────────────────────────────────────────────────────────
# Web client and server bundle (apps/server/dist, including dist/client).
echo "==> building the web client and server bundle"
pnpm exec vp run --filter t3 build; or begin; restore_release_manifests; exit 1; end

# Native resource monitor. The target dir is pinned so a relative target-dir in
# a global cargo config cannot send the binary somewhere the archive step won't
# look.
echo "==> building the resource monitor"
set --export CARGO_TARGET_DIR $repo/native/resource-monitor/target
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml; or begin; restore_release_manifests; exit 1; end
set --local stage (mktemp -d)
mkdir -p $stage/resource-monitor/linux-x64
cp $CARGO_TARGET_DIR/release/t3-resource-monitor $stage/resource-monitor/linux-x64/; or begin; restore_release_manifests; exit 1; end

# Single executable. vp packs it with the Node that runs it, and that Node must
# be 25.7+ (upstream's CI gets one through its global vp instead). Run this step
# on the exact version upstream bundles, `engines.node` in the root
# package.json (apps/server/vite.config.ts refuses any other), installed
# through mise.
set --local sea_node_version (string match -r '"node": "([^"]+)"' < package.json)[2]
if test -z "$sea_node_version"
    echo "no engines.node in package.json — refusing to guess the executable's Node"
    restore_release_manifests
    exit 1
end
echo "==> building the single executable (Node $sea_node_version)"
mise install --quiet node@$sea_node_version; or begin; restore_release_manifests; exit 1; end
mise exec node@$sea_node_version -- node apps/server/scripts/cli.ts build-exe; or begin; restore_release_manifests; exit 1; end

# Archive: the executable, the web client, the resource monitor, and the native
# packages the bundle keeps external — the same unit the installer downloads.
echo "==> packing the CLI archive"
node scripts/build-cli-archive.ts --platform linux --arch x64 --version $build_version --resource-monitor-dir $stage/resource-monitor --output-dir $stage/release; or begin; restore_release_manifests; exit 1; end
restore_release_manifests

set --local archive $stage/release/t3-$build_version-linux-x64.tar.gz
if not test -f $archive
    echo "no archive at $archive"
    exit 1
end

# ── Sanity-check the archive really is the fork ──────────────────────────────
set --local unpacked $stage/unpacked
mkdir -p $unpacked
tar -xzf $archive -C $unpacked --strip-components=1; or exit 1
for marker in quota_reserve
    if not grep -qa $marker $unpacked/t3
        echo "built executable is missing '$marker' — refusing to install"
        exit 1
    end
end
for marker in font-size-chat modelProfiles
    if not grep -rqa $marker $unpacked/client
        echo "built web client is missing '$marker' — refusing to install"
        exit 1
    end
end
if not grep -qa $T3CODE_RELAY_URL $unpacked/t3
    echo "built executable is missing the T3 Connect relay URL — refusing to install"
    exit 1
end
set --local reported_version ($unpacked/t3 --version | string match -r '\d+\.\d+\.\d+\S*')
if test "$reported_version" != "$build_version"
    echo "built executable reports '$reported_version', expected '$build_version' — refusing to install"
    exit 1
end

# ── Install ──────────────────────────────────────────────────────────────────
# Unpack into the pinned-runtime layout and mark it complete, so `t3 service
# install` reuses it instead of fetching a release.
set --local t3_home $HOME/.t3
set --local target_dir $t3_home/runtime/versions/$build_version
set --local previous_version (string match -r '"activeVersion": "([^"]+)"' < $t3_home/runtime/service-state.json)[2]
echo "==> installing to $target_dir"
rm -rf $target_dir
mv $unpacked $target_dir; or exit 1
echo $build_version > $target_dir/.install-complete
mkdir -p $HOME/.local/bin
ln -sfn $target_dir/t3 $HOME/.local/bin/t3

# The fork version is a semver prerelease of upstream's (0.0.45-zxtra.g… sorts
# below 0.0.45), so the service sees every switch to it as a downgrade.
echo "==> switching the service to $build_version"
$HOME/.local/bin/t3 service install --allow-downgrade; or exit 1
rm -rf $stage

echo
echo "installed: t3 $build_version"
echo "previous:  $previous_version (still in $t3_home/runtime/versions)"
echo "roll back: ln -sfn $t3_home/runtime/versions/$previous_version/t3 ~/.local/bin/t3; and t3 service install"
echo
echo "Don't run `t3 update` here: it would replace the fork with an upstream release."
