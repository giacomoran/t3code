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

`Settings → Appearance → Math (LaTeX) in chat` (on by default).

Renders formulas with KaTeX in all four delimiter styles:

| Written | Renders as |
| ------- | ---------- |
| `$x$`   | inline     |
| `\(x\)` | inline     |
| `$$x$$` | display    |
| `\[x\]` | display    |

Single-line `$$…$$` is promoted to a centered display equation — micromark only treats
`$$` as display math when the delimiters sit on their own lines, but assistants emit the
single-line form constantly.

LaTeX's own `\(…\)` / `\[…\]` are rewritten to the dollar forms before parsing, because
CommonMark treats `\(` as an escape for a literal `(` — by the time the markdown is a
syntax tree the backslashes are gone and no plugin could see them. That rewrite is
length-preserving on purpose: task-list toggling splices files by byte offset into this
same string, so moving a single character would break checkboxes that follow a formula.
Code fences and inline spans are copied through untouched.

KaTeX runs _after_ HTML sanitization on purpose: it emits the MathML and presentational
spans that make up a formula, none of which survive the sanitize schema. Author HTML is
still sanitized first, so only markup KaTeX generates from already-sanitized math text
gets through.

Turn the setting off if `$` runs in prose (shell variables, prices) start getting
mistaken for math.

### 3. Model profiles

A row of chips in the composer footer, next to the model picker.

Each chip is a named snapshot of a **provider instance + model + every trait** (reasoning
effort, fast mode, context window, …). One click restores the whole combination instead
of walking three menus — e.g. "GPT Luna · low · fast".

- **Save** the current setup with the `+` button (the name field pre-fills from the model
  and its traits).
- **Apply** with a single click on the chip. The active chip is highlighted.
- **Delete** from the same popover.

Applying a profile replaces traits outright rather than merging them, so a profile with
no traits resets to provider defaults instead of inheriting whatever was set before.

Profiles are client-local (stored in client settings, not on the server), capped at 24.

## Updating from upstream

```fish
cd ~/Projects/zxtra/t3code
git fetch upstream
git rebase upstream/main zxtra
pnpm install   # only when the lockfile moved
```

The changes are deliberately kept small and concentrated so this stays cheap. Most of the
new code lives in files upstream does not have, which never conflict:

- `apps/web/src/markdown-math-display.ts`
- `apps/web/src/markdown-math-delimiters.ts`
- `apps/web/src/modelProfiles.ts`
- `apps/web/src/components/chat/ModelProfilesBar.tsx`

Only these upstream files are modified, each in one or two spots:

| File                                                        | Why                                    |
| ----------------------------------------------------------- | -------------------------------------- |
| `packages/contracts/src/settings.ts`                        | new settings + `ModelProfile` schema   |
| `apps/web/src/appearanceFonts.ts`                           | `--font-size-chat` variable            |
| `apps/web/src/routes/__root.tsx`                            | applies the chat size                  |
| `apps/web/src/components/ChatMarkdown.tsx`                  | chat size + math plugins               |
| `apps/web/src/components/settings/SettingsPanels.tsx`       | the two Appearance rows                |
| `apps/web/src/components/settings/SettingsFontPreviews.tsx` | chat font preview                      |
| `apps/web/src/components/settings/settingsSearch.ts`        | makes the rows searchable              |
| `apps/web/src/components/chat/ChatComposer.tsx`             | renders the profiles bar               |
| `apps/web/src/components/ChatView.tsx`                      | applies a profile                      |
| `apps/web/src/main.tsx`                                     | KaTeX stylesheet                       |
| `apps/web/package.json`                                     | `katex`, `remark-math`, `rehype-katex` |

If a rebase conflicts, it will almost always be one of the small hunks in the table
above.

## Building and running

This repo needs Node 24 (`.tool-versions` pins 24.19.0 locally and is kept out of the
fork's diff via `.git/info/exclude`).

```fish
pnpm install
pnpm dev                 # web + server; prints a pairing URL to open
pnpm dist:desktop:dmg    # build the desktop app to install over the released one
```

Checks:

```fish
pnpm tc                                        # typecheck
cd apps/web; and pnpm test                     # unit tests
cd packages/contracts; and pnpm test
```
