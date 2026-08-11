#!/usr/bin/env bash
# Co-op playtest orchestrator — see DESIGN.md.
#   ./run-pilot.sh drivers   boot dev server + both drivers, then exit (for rails testing)
#   ./run-pilot.sh           full pilot: drivers + two pi player sessions
#   ./run-pilot.sh teardown  stop drivers + any dev server this script started
#
# HEADED=1 opens real Chromium windows so you can watch the run; every run also
# records video into reports/video/<RUNID>/ regardless.
set -euo pipefail
# Job control: each background job gets its own process group, so `kill -- -PID`
# reaches the whole tree (pi and its children) instead of just the subshell.
set -m

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_ROOT="$(cd "$DIR/../.." && pwd)"
CONSTELLATION="${CONSTELLATION:-$HOME/Projects/constellation}"
LAPTOP_MODEL="${LAPTOP_MODEL:-google/gemini-3.5-flash-lite}"
PHONE_MODEL="${PHONE_MODEL:-google/gemini-3.1-flash-lite}"
PILOT_TIMEOUT_S="${PILOT_TIMEOUT_S:-1500}"
# Single-sourced with the drivers, which read these same names.
LAPTOP_DRIVER_PORT="${LAPTOP_DRIVER_PORT:-4801}"
PHONE_DRIVER_PORT="${PHONE_DRIVER_PORT:-4802}"
GAME_PORT="${GAME_PORT:-5180}"
RELAY_PORT="${RELAY_PORT:-3081}"
# The drivers navigate by URL, not port, so GAME_PORT has to reach them as one —
# otherwise the script health-checks one server while Chromium opens another.
export GAME_URL="${GAME_URL:-http://localhost:$GAME_PORT/?test=1}"
export PHONE_URL="${PHONE_URL:-http://localhost:$GAME_PORT/phone.html}"
export LAPTOP_DRIVER_PORT PHONE_DRIVER_PORT
# /shutdown finalizes and copies the run's video before it answers, so this has
# to bound a whole recording rather than a ping.
SHUTDOWN_TIMEOUT_S="${SHUTDOWN_TIMEOUT_S:-90}"
L="http://127.0.0.1:$LAPTOP_DRIVER_PORT"
P="http://127.0.0.1:$PHONE_DRIVER_PORT"
MODE="${1:-pilot}"

mkdir -p "$DIR/logs" "$DIR/reports"

wait_http() { # url [timeout_s]
	local url="$1" deadline=$((SECONDS + ${2:-60}))
	until curl -sf -m 2 "$url" >/dev/null 2>&1; do
		((SECONDS < deadline)) || { echo "ERROR: timed out waiting for $url" >&2; return 1; }
		sleep 1
	done
}

# Kill a recorded pid and, since `set -m` gave it its own group, everything it
# spawned. The group kill is what reaches npm's vite/relay children and pi's.
stop_pidfile() {
	local f="$1"
	[[ -f $f ]] || return 0
	local pid
	pid="$(cat "$f")"
	kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
	rm -f "$f"
}

# Last-resort reaper for anything still holding a port — a process group we
# never recorded (a hand-started dev server, a driver from an interrupted run).
stop_port() {
	local pids
	pids="$(lsof -ti "tcp:$1" 2>/dev/null || true)"
	[[ -n $pids ]] && kill $pids 2>/dev/null || true
}

# Report what each driver said it saved. A driver that never opened a page has
# no video and says so with a null — only the end-of-run check (step 7) knows
# whether one was actually expected, so this reports and does not judge.
stop_drivers() {
	local url out file
	for url in "$L" "$P"; do
		out="$(curl -s -m "$SHUTDOWN_TIMEOUT_S" -X POST "$url/shutdown" 2>/dev/null || true)"
		file="$(printf '%s' "$out" | sed -n 's/.*"videoFile":"\([^"]*\)".*/\1/p')"
		[[ -n $file ]] && echo "  video saved: $file"
	done
	sleep 1
	stop_pidfile "$DIR/logs/laptop-driver.pid"
	stop_pidfile "$DIR/logs/phone-driver.pid"
	return 0
}

if [[ $MODE == teardown ]]; then
	stop_drivers
	# Only stop the dev server if this script started it; the pid file is that
	# record. Ports go too — `npm run dev` is a wrapper around vite + the relay.
	if [[ -f $DIR/logs/dev.pid ]]; then
		stop_pidfile "$DIR/logs/dev.pid"
		stop_port "$GAME_PORT"
		stop_port "$RELAY_PORT"
	fi
	echo "torn down"
	exit 0
fi

# Cleanup on every exit path, not just the happy one — a Ctrl-C, or the
# preflight's own `exit 1` when a model's daily quota is spent, would otherwise
# leave two drivers and their Chromium instances holding :4801/:4802. The two
# flags are separate because the drivers outlive the sessions in `drivers` mode,
# and because the drivers are up long before there are any sessions to kill.
CLEANUP_DRIVERS=0
CLEANUP_SESSIONS=0
on_exit() {
	if ((CLEANUP_SESSIONS)); then
		CLEANUP_SESSIONS=0
		# `|| true` on each kill, in an `if` rather than an `&&` chain: `kill` on an
		# already-exited process group returns 1, and under `set -e` a failure after
		# the final `&&` aborts the handler. The two players finish independently, so
		# "one already gone" is the normal state — without this, reaping the finished
		# session strands the live one AND skips driver cleanup entirely.
		if [[ -n ${LAPTOP_PID:-} ]]; then kill -- -"$LAPTOP_PID" 2>/dev/null || true; fi
		if [[ -n ${PHONE_PID:-} ]]; then kill -- -"$PHONE_PID" 2>/dev/null || true; fi
	fi
	if ((CLEANUP_DRIVERS)); then
		CLEANUP_DRIVERS=0
		stop_drivers
	fi
	return 0
}
trap on_exit EXIT INT TERM

# Background a long-lived service: `exec` so `$!` is the service's own pid (and,
# under `set -m`, its process-group leader — that is what makes `kill -- -$pid`
# reach npm's vite/relay children), and `disown` so the shell does not block on
# it at exit. Args: pidfile logfile cmd...
spawn_service() {
	local pidfile="$1" logfile="$2"
	shift 2
	"$@" </dev/null >"$logfile" 2>&1 &
	local pid=$!
	echo "$pid" >"$pidfile"
	disown "$pid" 2>/dev/null || true
}

# 1. constellation dev server (vite :5180 + relay :3081)
if ! curl -sf -m 2 "http://localhost:$GAME_PORT" >/dev/null 2>&1; then
	echo "starting constellation dev server..."
	spawn_service "$DIR/logs/dev.pid" "$DIR/logs/dev.log" \
		bash -c 'cd "$1" && exec npm run dev' _ "$CONSTELLATION"
fi
wait_http "http://localhost:$GAME_PORT" 90
wait_http "http://localhost:$RELAY_PORT/healthz" 90
echo "constellation up (game :$GAME_PORT, relay :$RELAY_PORT)"

# 2. harness deps
if [[ ! -d "$DIR/node_modules" ]]; then
	echo "installing harness deps..."
	(cd "$DIR" && npm install --no-fund --no-audit)
fi

# 3. run identity — minted before the drivers start so they can record into it
RUNID="$(date +%Y%m%d-%H%M%S)"
CHANNEL="playtest-$RUNID"
export VIDEO_DIR="$DIR/reports/video/$RUNID"
mkdir -p "$VIDEO_DIR"

# 4. drivers (replace any stale ones — the curls are the polite path, the pid
# files catch a driver whose command chain wedged and can't answer /shutdown)
stop_drivers
spawn_service "$DIR/logs/laptop-driver.pid" "$DIR/logs/laptop-driver.log" node "$DIR/driver/laptop.mjs"
spawn_service "$DIR/logs/phone-driver.pid" "$DIR/logs/phone-driver.log" node "$DIR/driver/phone.mjs"
CLEANUP_DRIVERS=1
wait_http "$L/health" 30
wait_http "$P/health" 30
echo "drivers up (laptop :$LAPTOP_DRIVER_PORT, phone :$PHONE_DRIVER_PORT)"
# `if`, not `[[ … ]] && echo`: the latter exits non-zero when HEADED is unset and
# `set -e` would kill the script right here (same trap F2 caught in the preflight).
if [[ ${HEADED:-} == 1 ]]; then
	echo "HEADED=1 — browser windows open on /boot and /join; video also lands in $VIDEO_DIR"
fi

if [[ $MODE == drivers ]]; then
	# The whole point of this mode is to leave the drivers up for rails testing.
	CLEANUP_DRIVERS=0
	echo "drivers-only mode — leaving everything running"
	exit 0
fi

# 5. preflight: one cheap request per player model — free-tier quotas are DAILY
# and pi's -p mode dies on the first 429, so a spent model means a DOA session.
for m in "$LAPTOP_MODEL" "$PHONE_MODEL"; do
	# `|| true`: under set -e/pipefail a failed probe would kill the script right
	# here, before the case below can print its diagnostic.
	out="$(cd "$PI_ROOT" && ./pi-test.sh -p -nc --no-extensions --no-session --model "$m" "Reply with exactly: OK" 2>&1 | tail -1)" || true
	case "$out" in
	*OK*) echo "preflight $m: ok" ;;
	*)
		echo "ERROR: preflight failed for $m — pick another model (LAPTOP_MODEL/PHONE_MODEL env):" >&2
		echo "$out" | head -c 400 >&2
		exit 1
		;;
	esac
done

# 6. two player sessions
render() {
	sed -e "s/__CHANNEL__/$CHANNEL/g" -e "s/__RUNID__/$RUNID/g" -e "s|__DIR__|$DIR|g" \
		-e "s/__LAPTOP_PORT__/$LAPTOP_DRIVER_PORT/g" -e "s/__PHONE_PORT__/$PHONE_DRIVER_PORT/g" "$1"
}
render "$DIR/prompts/laptop.md" >"$DIR/logs/$RUNID-prompt-laptop.txt"
render "$DIR/prompts/phone.md" >"$DIR/logs/$RUNID-prompt-phone.txt"

echo "launching player sessions (run $RUNID, channel $CHANNEL)"
echo "  laptop: $LAPTOP_MODEL   phone: $PHONE_MODEL"
(cd "$PI_ROOT" && ./pi-test.sh -p -nc -a --model "$LAPTOP_MODEL" -n "playtest-laptop-$RUNID" \
	"$(cat "$DIR/logs/$RUNID-prompt-laptop.txt")" </dev/null >"$DIR/logs/$RUNID-session-laptop.log" 2>&1) &
LAPTOP_PID=$!
(cd "$PI_ROOT" && ./pi-test.sh -p -nc -a --model "$PHONE_MODEL" -n "playtest-phone-$RUNID" \
	"$(cat "$DIR/logs/$RUNID-prompt-phone.txt")" </dev/null >"$DIR/logs/$RUNID-session-phone.log" 2>&1) &
PHONE_PID=$!
CLEANUP_SESSIONS=1

deadline=$((SECONDS + PILOT_TIMEOUT_S))
while kill -0 "$LAPTOP_PID" 2>/dev/null || kill -0 "$PHONE_PID" 2>/dev/null; do
	if ((SECONDS > deadline)); then
		echo "TIMEOUT after ${PILOT_TIMEOUT_S}s — killing player sessions" >&2
		# Group kill: `$LAPTOP_PID` is the subshell, and pi runs inside it.
		kill -- -"$LAPTOP_PID" -"$PHONE_PID" 2>/dev/null || true
		break
	fi
	sleep 5
done
wait "$LAPTOP_PID" 2>/dev/null || true
wait "$PHONE_PID" 2>/dev/null || true

# 7. teardown drivers (keep the dev server; teardown mode stops it). Shutting
# them down is also what flushes the recorded video to disk, so `stop_drivers`
# prints the file each one actually wrote.
CLEANUP_SESSIONS=0
CLEANUP_DRIVERS=0
echo "stopping drivers (this also flushes the recordings)..."
stop_drivers

echo
echo "run $RUNID finished. reports:"
ls -la "$DIR/reports" 2>/dev/null | grep "$RUNID" || echo "  (none written — check logs/$RUNID-session-*.log)"
# A run that played reached /boot and /join, so both recordings are expected —
# say so plainly when one is missing rather than pointing at an empty directory.
if compgen -G "$VIDEO_DIR/*.webm" >/dev/null; then
	echo "video:"
	ls -1 "$VIDEO_DIR"/*.webm | sed 's/^/  /'
else
	echo "WARNING: no video written to $VIDEO_DIR — check logs/*-driver.log" >&2
fi
