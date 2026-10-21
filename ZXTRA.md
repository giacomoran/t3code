# zxtra fork of T3 Code

A personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) that adds
a few things upstream does not have. Upstream is not accepting feature contributions
(see `CONTRIBUTING.md`), and its README explicitly encourages forking, so these live here
instead of in a PR.

Everything sits on the **`zxtra`** branch. `main` tracks upstream untouched, so it is
always a clean base to rebase onto.

## What this fork adds

### 1. Chat font size

`Settings → Appearance → Chat font size` (12–20px, default 14).

Sizes the chat transcript independently of the interface font, so message prose can be
enlarged for reading without inflating every surrounding control. Code blocks inside a
message keep following the existing _Code font size_, so they do not move with it.

### 2. Model profiles

A single dropdown in the composer footer, next to the model picker.

A profile is a named snapshot of a **provider instance + model + every trait** (reasoning
effort, fast mode, context window, …). Picking one restores the whole combination instead
of walking three menus — e.g. "GPT Luna · low · fast".

The control is a dropdown rather than a row of chips because names derive from the model
and its traits, so three of them spelled out side by side crowded the footer and pushed
the traits and mode controls into an invisible horizontal scroll.

- **Trigger** shows the profile the composer currently sits on, or "Profiles" when the
  setup matches none of them.
- **Apply** by picking a row; the active row is checked.
- **Save** the current setup from the field at the bottom of the same popup (it pre-fills
  from the model and its traits).
- **Delete** with the trash button on the row.

Applying a profile replaces traits outright rather than merging them, so a profile with
no traits resets to provider defaults instead of inheriting whatever was set before.

Profiles are client-local (stored in client settings, not on the server), capped at 24.

### 3. No cite button on selected text

Removed. Selecting text in an assistant message popped up a floating **Cite** button
that attached the selection to the composer as a quoted citation — an affordance that
appears on every selection, including the ones made to copy a line or just to read.

Only the button is gone. The rest of upstream's citation machinery — the composer
chip, the citation node, the anchors that mark assistant text as citable — is left
untouched and simply has nothing left to trigger it. Removing that too would mean
editing the composer, the prompt editor, and the timeline plumbing, which is a large
fork surface for no visible gain; deleting the one mount point is a single hunk that
survives rebases.

`MessagesTimeline` still declares `onCiteAssistantText` so its callers upstream keep
compiling unchanged. It is never read.

### 4. Claude and Codex quota reserves

`Settings → Providers → Claude → Quota reserve (%)` (and the same for Codex) reserves
`1`–`99` percent of the five-hour subscription window; an empty field disables it.
Once usage reaches the threshold, new turns on that provider instance are failed
before they reach the provider, and running turns are interrupted. Both end as a
`usage_limit` failure carrying the window's reset time, so upstream's own limit
banner, queue hold, Continue, snooze and auto-resume at reset all apply unchanged.
`/reserve`, Continue, or auto-resume on a reserve stop lets that one thread spend
the reserve until the window resets; the blocked prompt is replayed by upstream's
missed-run handoff. See [Claude](docs/user/providers-claude.md#keep-a-quota-reserve)
and [Codex](docs/user/providers-codex.md#keep-a-quota-reserve).

Inspired by [spare10](https://github.com/alesdi/spare10). The guard reads the same
per-instance usage snapshot as Stats, which the V2 adapters already update from
streamed rate-limit events; it never probes an agent. Missing or stale readings log
a warning once and let work continue.

The logic lives in `apps/server/src/orchestration-v2/quotaReserve/`: the shared
state and evaluation, a provider-adapter registry decorator that tracks running
turns and turns a reserve-triggered interrupt into the failure (ordinary stops pass
through), a monitor that reacts to snapshot changes plus the 5s scheduler tick, and
a `ThreadManagementService` decorator for `/reserve` and continuations.
`QuotaReserve` is a `Context.Reference` with a no-op default so upstream tests that
build `ProviderTurnStartService` need no changes — which also means a wiring
mistake in `runtimeLayer.ts` disables the feature silently instead of failing to
compile.

### 5. An empty list marker that starts a list stays

In the composer, Enter on an empty item continues or exits a list. Upstream removes the
marker when the item is empty, which is right for an item continuation just inserted, but
wrong for a `1. ` or `- ` typed on purpose at the top of a list. The marker is now removed
only when the line above is also a list item; otherwise Enter is a plain newline. Upstream
covers the no-space case (`1.`) since v0.1.1; this covers the rest.

### Dropped: math (LaTeX) in chat

The fork rendered LaTeX with KaTeX behind a three-way setting until v0.1.1, when
upstream shipped its own (`Settings → Appearance → Render math`, off by default, saved per
device). Upstream's reads every delimiter the fork did, keeps prices such as `$5 and $10`
as text, and also renders on mobile, so the fork's version was removed on that rebase
rather than kept as a second math pipeline.

## Updating from upstream

This fork is not auto-updated — that is the trade for it not silently reverting to an
upstream release (see [Why there is no auto-update](#why-there-is-no-auto-update)).
Updating is: rebase, rebuild, reinstall.

```fish
cd ~/Projects/zxtra/t3code
./zxtra/check-upstream.fish      # pre-flight: read this before deciding
git rebase upstream/main zxtra
pnpm install                     # only when the lockfile moved
pnpm tc                          # sanity-check the rebase before building
./zxtra/build-and-install.fish   # build, sign, back up, install
```

Then rebuild every Linux server that runs the fork — see
[Running the fork's server on Linux](#running-the-forks-server-on-linux). The desktop app
and the servers it connects to must come from the same fork.

### The pre-flight check

`zxtra/check-upstream.fish` fetches and reports; it changes nothing. Run it — or hand
it to an agent — before committing to an update. Takes a second or two.

A clean rebase is not the same as a working one. Everything the fork adds is small and
self-contained, so git will usually merge it without complaint; what actually breaks it
is upstream _renaming a field the fork reads_ or _changing a helper it calls_. That
produces no conflict and often no type error in the files the fork touched — the
feature just quietly stops working. So the check verifies those assumptions by name:

1. **What upstream did** — commit count, date span, which areas moved.
2. **Collision risk** — upstream commits to the files the fork also edits, with
   subjects, so you can see whether they are near the fork's hunks.
3. **Path collisions** — upstream adding a file the fork also adds.
4. **Load-bearing assumptions** — every upstream symbol the fork depends on, checked
   against the upstream tree. A miss names the symbol, the file, and what it holds up.
5. **Did upstream build it themselves?** — a hit means the fork's patch may now be
   redundant, and carrying it forward could conflict in behaviour rather than in text.

Exit codes: `0` proceed, `2` stop and read section 4 or 3 first.

**A pass is not a promise.** It confirms the things the fork knows it depends on still
exist — it cannot see a field that kept its name but changed meaning, or a turn state
that gained a new value. Sections 1 and 2 are there to be read by a human or an agent,
not just skimmed for the verdict. After any non-trivial rebase, run the suites and
actually exercise the fork's features before trusting the build.

Run the test suites too if the rebase touched anything the fork edits — see
[Checks](#building-and-running).

Then quit T3 Code fully (Cmd-Q) and relaunch.

**Confirm you are on the fork:** `Settings → Appearance` shows **Chat font size**, which
does not exist upstream. The version string still reads
whatever upstream's does — the fork is not separately versioned, so do not use it to
tell the builds apart.

`zxtra/build-and-install.fish` refuses to install a bundle that is missing the fork's
own code, or one that arrived carrying an update feed, so a botched build cannot
quietly replace a working app. It backs the current app up to
`/Applications/T3 Code (Beta).app.<timestamp>.bak`; delete those once you are happy,
they are ~400MB each.

### What tends to conflict

The changes are deliberately small and concentrated. Most of the new code lives in
files upstream does not have, which never conflict:

- `apps/web/src/modelProfiles.ts`
- `apps/web/src/components/chat/ModelProfilesBar.tsx`
- `apps/server/src/orchestration-v2/quotaReserve/*`

Only these upstream files are modified, each in one or two spots:

| File                                                           | Why                                  |
| -------------------------------------------------------------- | ------------------------------------ |
| `packages/contracts/src/settings.ts`                           | new settings + `ModelProfile` schema |
| `apps/web/src/appearanceFonts.ts`                              | `--font-size-chat` variable          |
| `apps/web/src/routes/__root.tsx`                               | applies the chat size                |
| `apps/web/src/components/ChatMarkdown.tsx`                     | applies the chat size                |
| `apps/web/src/components/settings/SettingsPanels.tsx`          | Appearance rows                      |
| `apps/web/src/components/settings/SettingsFontPreviews.tsx`    | chat font preview                    |
| `apps/web/src/components/settings/settingsSearch.ts`           | makes the rows searchable            |
| `apps/web/src/components/chat/ChatComposer.tsx`                | renders the profiles dropdown        |
| `apps/web/src/components/ChatView.tsx`                         | applies a profile                    |
| `apps/web/src/components/chat/MessagesTimeline.tsx`            | drops the cite-selection button      |
| `apps/web/src/composer-list-continuation.ts`                   | keeps a list-starting empty marker   |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | quota gate before a turn starts      |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`             | wires the quota decorators           |
| `apps/server/src/provider/ClaudeProvider.ts`                   | `/reserve` slash command             |
| `apps/server/src/provider/CodexProvider.ts`                    | `/reserve` slash command             |

If a rebase conflicts, it will almost always be one of the small hunks in the table
above.

## Toolchain

Two pinned versions, both via asdf:

|      | version | why                                                                 |
| ---- | ------- | ------------------------------------------------------------------- |
| Node | 24.19.0 | the repo's `engines` field requires `^24.13.1`                      |
| Rust | 1.98.0  | the native resource monitor needs >= 1.95 (`sysinfo` refuses older) |

They are pinned in `.tool-versions`, which is deliberately kept out of the fork's git
diff via `.git/info/exclude`. **Neither file survives a fresh clone**, so after
re-cloning, recreate them:

```fish
printf 'nodejs 24.19.0\nrust 1.98.0\n' > .tool-versions
printf '\n# zxtra-local: keep local toolchain pin out of the fork diff\n.tool-versions\n' >> .git/info/exclude
```

### Two things that break the desktop build on this machine

Both are handled by `zxtra/build-and-install.fish`; they are written down here because
they are invisible failures if you ever build by hand.

**`~/.cargo/config.toml` sets a relative `target-dir`.** Cargo resolves it against the
home directory, so the resource monitor builds into `~/target` while the packaging step
looks in `native/resource-monitor/target` — and fails with
`ResourceMonitorBuildOutputMissingError` even though the binary compiled fine. The
script overrides `CARGO_TARGET_DIR` for the build only; the global config is untouched.

**electron-builder leaves an invalid signature.** With no Apple signing identity on the
machine it produces a bundle that fails `codesign --verify` with _"code has no resources
but signature indicates they must be present"_, which macOS refuses to launch on arm64.
The fix is an ad-hoc re-sign of the staged bundle before installing:
`codesign --force --deep --sign - "<app>"`.

### Why there is no auto-update

The release build ships `Contents/Resources/app-update.yml` pointing at
`pingdotgg/t3code`, and electron-updater will happily replace the app with an upstream
release. A local build never gets that file: the packaging script only writes a publish
config when `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` is set, and
neither is set locally. So this fork cannot be overwritten by upstream — and equally,
it will never update itself. The install script asserts the file is absent rather than
trusting that.

Because the bundle id is unchanged (`com.t3tools.t3code`), the fork shares the release
app's data directory, so threads and projects carry over. Secrets held by Electron's
`safeStorage` (saved SSH/connection credentials) are keyed to the code signature, which
changes from Apple-signed to ad-hoc — expect to re-enter those once. Local environments
are unaffected.

### T3 Connect in a local build

Upstream's release workflow injects T3 Connect's public configuration at build time: the
relay URL, the Clerk publishable key and JWT template, and the CLI's OAuth client ID. A
local build gets none of it, so the app hides T3 Connect sign-in and `t3 connect` prints
_"T3 Connect is unavailable in builds without public configuration"_. That matters for
more than remote access: the mobile app's push notifications only reach a server linked
to T3 Connect, whatever route — Tailscale included — the app otherwise uses.

`zxtra/t3-connect.env` holds those values, read out of the v0.1.0 release, and both
build-and-install scripts export them before building, then refuse to install a build
that lacks the relay URL. None of them is a secret; every official binary carries them
in plain text. If T3 Connect sign-in starts failing after an upstream update, compare
them against the latest release first.

## Running the fork's server on Linux

The desktop app also connects to a Linux server (epsilon) over Tailscale, and that server
runs this fork too. Mixing builds breaks in two ways:

- **"Client not supported"**: the app and server speak different orchestration protocol
  versions (`ORCHESTRATION_PROTOCOL_VERSION` in `packages/contracts/src/environment.ts`).
- **"The authenticated token is missing required scope"**: when pairing, the app requests
  the scopes it knows about, and a session keeps the scopes it was issued with. After the
  app gains a scope, pair again (`t3 pair --tailscale` on the server, then remove and re-add
  the environment in the app).

The fork's checkout on epsilon lives in `~/Projects/t3code`. Updating it after a rebase:

```fish
cd ~/Projects/t3code
git fetch origin; and git reset --hard origin/zxtra   # the rebase was force-pushed
pnpm install
./zxtra/build-and-install-linux.fish
```

`zxtra/build-and-install-linux.fish` follows the steps upstream's release workflow uses for
the Linux CLI archive:

1. Stamps the version `<upstream version>-zxtra.g<commit>` into the release manifests, and
   restores them when the build ends. The service keys its runtime folder on the version
   the binary reports, so the fork needs a version of its own.
2. Builds the web client and server bundle, the Rust resource monitor, and the single
   executable. The executable step runs on Node `SEA_NODE_VERSION` (from
   `apps/server/vite.config.ts`, installed through mise), because `vp pack` needs a Node
   25.7+ host.
3. Packs the CLI archive, then refuses to install it if it lacks the fork's markers or
   reports the wrong version.
4. Unpacks it into `~/.t3/runtime/versions/<version>`, where `t3 service install` looks
   for a pinned runtime, and switches the service with `--allow-downgrade`: a semver
   prerelease such as `0.0.45-zxtra.g…` sorts below `0.0.45`.

The previous runtime stays in `~/.t3/runtime/versions`, and the script prints the
command to roll back to it. **Don't run `t3 update` on the server**: it would replace the
fork with an upstream release.

Linux toolchain: Node and Rust from `.tool-versions` through mise (recreate it as in
[Toolchain](#toolchain)), pnpm from `packageManager`, plus `libsecret-1-dev` and
`pkg-config` from apt.

## Building and running

Toolchain first (see above). Then:

```fish
pnpm install
pnpm dev     # web + server; prints a pairing URL — open it to pair the dev instance
```

`pnpm dev` runs against `~/.t3/dev`, isolated from the installed app's data, so it
cannot disturb your real threads. Auto-update is off in dev builds regardless.

To produce and install the desktop app, use `./zxtra/build-and-install.fish` rather
than calling `pnpm dist:desktop:dmg:arm64` directly — on its own that build fails, and
when it succeeds it produces a bundle macOS will not launch. See
[Two things that break the desktop build](#two-things-that-break-the-desktop-build-on-this-machine).

Checks:

```fish
pnpm tc                                     # typecheck (whole repo)
cd apps/web; and pnpm test; and cd -
cd packages/contracts; and pnpm test; and cd -
cd apps/server; and pnpm test; and cd -     # entrypoint.test.ts fails upstream too
```
