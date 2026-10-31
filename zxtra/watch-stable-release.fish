#!/usr/bin/env fish
#
# Start a T3 Code thread that updates this fork each time upstream publishes a
# new stable release. The t3code-fork-watch timer runs it every day at 4:00 on
# epsilon, or at its next boot when epsilon was off at 4:00 (see ZXTRA.md →
# Updating on each stable release). When nothing is new it costs
# one GitHub API call and two fetches, and starts no agent.
#
# The thread runs in this checkout with the instructions in
# update-thread-prompt.md, and a marker in $state_dir remembers which release
# it was started for, so each release gets one thread.

set --local repo (cd (dirname (status filename))/..; and pwd)
cd $repo; or exit 1
set --local state_dir $HOME/.local/state/t3code-fork-update

# The latest stable release. GitHub's "latest" skips drafts and prereleases
# (nightlies, previews); anything but a plain vX.Y.Z tag is a surprise.
set --local tag (gh api repos/pingdotgg/t3code/releases/latest --jq .tag_name); or exit 1
if not string match --quiet --regex '^v\d+\.\d+\.\d+$' -- $tag
    echo "latest release tag '$tag' is not vX.Y.Z — refusing to guess"
    exit 1
end

git fetch --quiet origin zxtra; or exit 1
git fetch --quiet --no-tags upstream tag $tag; or exit 1

if git merge-base --is-ancestor $tag origin/zxtra
    echo "zxtra already contains $tag"
    exit 0
end

# One update at a time: a thread started for an earlier release that zxtra does
# not contain yet is still working or waiting for an answer, in this same
# checkout. The next run after it lands starts the newer release's thread.
mkdir -p $state_dir
for marker in $state_dir/v*
    set --local tag_open (basename $marker)
    if not git merge-base --is-ancestor $tag_open origin/zxtra 2>/dev/null
        echo "update thread for $tag_open is still open: "(cat $marker)
        exit 0
    end
end

# Start the thread, then record its id: the thread reads it back from the
# marker to have the Linux install report to it.
echo "==> starting the update thread for $tag"
set --local prompt (string replace --all '{{tag}}' $tag < $repo/zxtra/update-thread-prompt.md | string collect)
set --local thread_id (printf '%s\n' $prompt | t3 thread start $repo --title "Update the fork to $tag" --provider claudeAgent --model claude-opus-5-5 -); or exit 1
echo $thread_id > $state_dir/$tag
echo "started thread $thread_id"
