Upstream T3 Code published the stable release {{tag}}. Update this fork to it:
rebase `zxtra` onto {{tag}}, push it, install it on epsilon, then hand the
macOS build on tiramisu over to me.

You run on epsilon, in `~/Projects/t3code`, the checkout epsilon's T3 Code
server is built from, and on that server. `zxtra/watch-stable-release.fish`
started you; your thread id is in `~/.local/state/t3code-fork-update/{{tag}}`.
Read `ZXTRA.md` first, all of it: it has the update loop, the checks, the
Linux install and what tends to conflict.

Rebase, commit and push without asking. Stop and ask me only for a real
decision, with your recommendation: the pre-flight check exits 2, upstream
has built something the fork adds, a conflict whose resolution changes what
one of the fork's features does, or dropping one of them. I read this thread
whenever I see it, so wait for the answer and do nothing irreversible
meanwhile.

1. `git status` is clean, on `zxtra`, equal to `origin/zxtra`. If not,
   something else is going on here: stop and ask. Note `origin/zxtra`'s
   commit; the handoff below needs it.
2. Pre-flight: `ZXTRA_UPSTREAM_REF={{tag}} ./zxtra/check-upstream.fish`.
   Read every section, not just the verdict.
3. Back up and rebase: `git branch zxtra-pre-{{tag}} zxtra`, then
   `git rebase {{tag}}`. Rebase onto the release tag, not `upstream/main`.
4. `pnpm install`, `pnpm tc`, and the test suites of the packages the fork
   touches (`ZXTRA.md` → Checks). Before you blame the fork for a failing
   test, run it on {{tag}} itself. Fix what the rebase broke in commits named
   `fix: adapt <feature> to the {{tag}} rebase`, as earlier updates did.
   Update `ZXTRA.md` where it no longer matches the code.
5. Push: `git push --force-with-lease=zxtra:<origin/zxtra's old commit> origin zxtra`.
6. Compare `ORCHESTRATION_PROTOCOL_VERSION` in
   `packages/contracts/src/environment.ts` between `zxtra-pre-{{tag}}` and
   `zxtra`. If it changed, the desktop app on tiramisu cannot reach epsilon
   from the moment one of them is updated until the other one is: post the
   handoff (step 9) first, and install here only once I say so.
7. Install on epsilon: `./zxtra/install-linux-detached.fish <your thread id>`.
   It restarts this server at the end, so it runs in the background, and you
   get a message with its outcome as your next turn: end your turn once it
   has started. Then check the log, `t3 --version` and the service. If the
   install failed, fix the cause and run it again.
8. Read the notes of every stable release after the fork's old base (the
   newest `vX.Y.Z` tag under `zxtra-pre-{{tag}}`) up to {{tag}}: list them
   with `gh release list -R pingdotgg/t3code --exclude-drafts --exclude-pre-releases`,
   then `gh release view <tag> -R pingdotgg/t3code` for each. Read its
   Highlights and Fixes; skim the full changelog only for what changes how I
   use the app.
9. Report, then end. Its first section is "What's new upstream": the notes
   grouped by release, newest first, a few plain bullets each, new features
   first, then fixes that matter, then anything I need to do (such as a new
   setting to turn on), with the upstream PR number where the notes give one.
   Then what upstream changed that touches the fork, each
   conflict and how you resolved it, the commits you added, and what you
   checked. Then, in one fenced block, a message I can paste to an agent on
   tiramisu. It tells that agent to:
   - in `~/Projects/zxtra/t3code`, check the tree is clean and that local
     `zxtra` is `origin/zxtra`'s old commit (name it), so no work there is
     lost, and stop and ask me if not;
   - `git fetch origin`, `git branch zxtra-pre-{{tag}} zxtra`,
     `git reset --hard origin/zxtra`, `pnpm install`, `pnpm tc`, then
     `./zxtra/build-and-install.fish`;
   - tell me to quit T3 Code (Cmd-Q) and relaunch it, and to check that
     Settings → Appearance shows Chat font size.

   Add to the message anything tiramisu needs that epsilon did not, such as a
   new pairing when the app gained a scope (`ZXTRA.md` → Running the fork's
   server on Linux).
