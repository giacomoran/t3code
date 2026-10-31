#!/usr/bin/env fish
#
# Run build-and-install-linux.fish outside the T3 Code server, then tell a
# thread how it went. For the update thread on epsilon: the install restarts
# the server that thread runs on, which would cut off a foreground install
# halfway through its turn.
#
#   ./zxtra/install-linux-detached.fish <thread-id>
#
# It starts a transient systemd user unit and returns at once. The unit runs
# the install into a log, then sends the thread a message with the exit code
# and the log's path, retrying while the restarted server comes back up.

set --local repo (cd (dirname (status filename))/..; and pwd)
cd $repo; or exit 1

if test (count $argv) -lt 1
    echo "usage: install-linux-detached.fish <thread-id>"
    exit 1
end
set --local thread_id $argv[1]

# Inside the unit: install, then report.
if test "$argv[2]" = --inside-unit
    set --local log $argv[3]
    ./zxtra/build-and-install-linux.fish >$log 2>&1
    set --local code $status
    set --local message "The Linux install ended with exit code $code; its log is $log. Read the log's end, check \`t3 --version\` and \`systemctl --user is-active t3code\`, then carry on with the update."
    for attempt in (seq 60)
        t3 thread send $thread_id $message; and exit 0
        sleep 10
    end
    echo "could not reach thread $thread_id after 10 minutes"
    exit 1
end

# Outside: start the unit with this shell's PATH, which has the toolchain.
set --local log $HOME/.t3/userdata/logs/fork-install-(date +%Y%m%dT%H%M%S).log
systemd-run --user --collect --unit=t3code-fork-install-(date +%s) \
    --working-directory=$repo --setenv=PATH=(string join : $PATH) \
    fish $repo/zxtra/install-linux-detached.fish $thread_id --inside-unit $log; or exit 1
echo "installing in the background; log: $log"
echo "the server restarts at the end, and thread $thread_id gets a message with the outcome"
