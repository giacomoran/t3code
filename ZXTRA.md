# zxtra fork of T3 Code

A personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT) that adds
three things upstream does not have. Upstream is not accepting feature contributions
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

### 2. Math (LaTeX) in chat

`Settings → Appearance → Math (LaTeX) in chat`, with three settings:

| Setting              | Renders                                 |
| -------------------- | --------------------------------------- |
| Off                  | nothing; formulas stay as source        |
| **LaTeX delimiters** | `\(x\)`, `\[x\]`, `$$x$$` — the default |
| Also `$…$`           | the above, plus single dollars          |

**Single-dollar math is opt-in, and that is the point.** A single `$` is both how
assistants write inline math and how prose writes money, and nothing in the syntax
distinguishes them. "roughly `$`1K to date … `$`1K spent" is a valid formula spanning
the sentence between the two amounts, and KaTeX renders it as one — the paragraph turns
into italic math and the text between the prices disappears into it. There is no
heuristic that reliably separates the two cases, so the ambiguous delimiter is the one
you turn on deliberately; the unambiguous ones are always available.

`\(x\)` is the delimiter to prefer for inline math. Assistants emit `$x$` more often,
so turn on "Also `$…$`" if you read more formulas than prices and are willing to accept
the failure above.

Single-line `$$…$$` is promoted to a centered display equation — micromark only treats
`$$` as display math when the delimiters sit on their own lines, but assistants emit the
single-line form constantly. That promotion is also what makes `\[x\]` on its own line
come out centred while `\(x\)` mid-sentence stays inline: both rewrite to `$$`, and
whether a formula is display is decided afterwards from whether it is a paragraph's
entire content.

LaTeX's own `\(…\)` / `\[…\]` are rewritten to `$$` before parsing, because CommonMark
treats `\(` as an escape for a literal `(` — by the time the markdown is a syntax tree
the backslashes are gone and no plugin could see them. That rewrite is length-preserving
on purpose: task-list toggling splices files by byte offset into this same string, so
moving a single character would break checkboxes that follow a formula. Code fences and
inline spans are copied through untouched.

KaTeX runs _after_ HTML sanitization on purpose: it emits the MathML and presentational
spans that make up a formula, none of which survive the sanitize schema. Author HTML is
still sanitized first, so only markup KaTeX generates from already-sanitized math text
gets through.

The web build generates open-source license notices and refuses any dependency without
a notice file in its tarball. `remark-math` and `rehype-katex` ship none — the
remark-math monorepo keeps a single `license` at its root — so
`third-party-licenses.config.json` carries a generated MIT notice for each.

### 3. Model profiles

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

### 4. No cite button on selected text

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

### 5. Claude and Codex quota reserves

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
5. **Dependency drift** — the markdown and indexing packages the fork leans on. A
   `@ff-labs/fff-node` bump is the signal to re-check the index-scan fix, which exists
   to work around that library's behaviour.
6. **Did upstream build it themselves?** — a hit means the fork's patch may now be
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

**Confirm you are on the fork:** `Settings → Appearance` shows **Chat font size** and
**Math (LaTeX) in chat**. Neither exists upstream. The version string still reads
whatever upstream's does — the fork is not separately versioned, so do not use it to
tell the builds apart.

`zxtra/build-and-install.fish` refuses to install a bundle that is missing the fork's
own code, or one that arrived carrying an update feed, so a botched build cannot
quietly replace a working app. It backs the current app up to
`/Applications/T3 Code (Alpha).app.<timestamp>.bak`; delete those once you are happy,
they are ~400MB each.

### What tends to conflict

The changes are deliberately small and concentrated. Most of the new code lives in
files upstream does not have, which never conflict:

- `apps/web/src/markdown-math-display.ts`
- `apps/web/src/markdown-math-delimiters.ts`
- `apps/web/src/modelProfiles.ts`
- `apps/web/src/components/chat/ModelProfilesBar.tsx`
- `apps/server/src/orchestration-v2/quotaReserve/*`

Only these upstream files are modified, each in one or two spots:

| File                                                           | Why                                    |
| -------------------------------------------------------------- | -------------------------------------- |
| `packages/contracts/src/settings.ts`                           | new settings + `ModelProfile` schema   |
| `apps/web/src/appearanceFonts.ts`                              | `--font-size-chat` variable            |
| `apps/web/src/routes/__root.tsx`                               | applies the chat size                  |
| `apps/web/src/components/ChatMarkdown.tsx`                     | chat size + math plugins               |
| `apps/web/src/components/settings/SettingsPanels.tsx`          | Appearance rows                        |
| `apps/web/src/components/settings/SettingsFontPreviews.tsx`    | chat font preview                      |
| `apps/web/src/components/settings/settingsSearch.ts`           | makes the rows searchable              |
| `apps/web/src/components/chat/ChatComposer.tsx`                | renders the profiles dropdown          |
| `apps/web/src/components/ChatView.tsx`                         | applies a profile                      |
| `apps/web/src/main.tsx`                                        | KaTeX stylesheet                       |
| `apps/web/package.json`                                        | `katex`, `remark-math`, `rehype-katex` |
| `third-party-licenses.config.json`                             | license notices for the math packages  |
| `apps/web/src/components/chat/MessagesTimeline.tsx`            | drops the cite-selection button        |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` | quota gate before a turn starts        |
| `apps/server/src/orchestration-v2/runtimeLayer.ts`             | wires the quota decorators             |
| `apps/server/src/provider/ClaudeProvider.ts`                   | `/reserve` slash command               |
| `apps/server/src/provider/CodexProvider.ts`                    | `/reserve` slash command               |

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
