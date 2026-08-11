#!/usr/bin/env bash
# Co-op playtest orchestrator — see DESIGN.md.
#   ./run-pilot.sh drivers   boot dev server + both drivers, then exit (for rails testing)
#   ./run-pilot.sh           full pilot: drivers + two pi player sessions
#   ./run-pilot.sh teardown  stop drivers + any dev server this script started
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_ROOT="$(cd "$DIR/../.." && pwd)"
CONSTELLATION="${CONSTELLATION:-$HOME/Projects/constellation}"
LAPTOP_MODEL="${LAPTOP_MODEL:-google/gemini-3.5-flash-lite}"
PHONE_MODEL="${PHONE_MODEL:-google/gemini-3.1-flash-lite}"
PILOT_TIMEOUT_S="${PILOT_TIMEOUT_S:-1500}"
MODE="${1:-pilot}"

mkdir -p "$DIR/logs" "$DIR/reports"

wait_http() { # url [timeout_s]
	local url="$1" deadline=$((SECONDS + ${2:-60}))
	until curl -sf -m 2 "$url" >/dev/null 2>&1; do
		((SECONDS < deadline)) || { echo "ERROR: timed out waiting for $url" >&2; return 1; }
		sleep 1
	done
}

stop_pidfile() {
	local f="$1"
	[[ -f $f ]] || return 0
	local pid
	pid="$(cat "$f")"
	kill "$pid" 2>/dev/null || true
	rm -f "$f"
}

if [[ $MODE == teardown ]]; then
	curl -s -m 5 -X POST http://127.0.0.1:4801/shutdown >/dev/null 2>&1 || true
	curl -s -m 5 -X POST http://127.0.0.1:4802/shutdown >/dev/null 2>&1 || true
	stop_pidfile "$DIR/logs/laptop-driver.pid"
	stop_pidfile "$DIR/logs/phone-driver.pid"
	stop_pidfile "$DIR/logs/dev.pid"
	echo "torn down"
	exit 0
fi

# 1. constellation dev server (vite :5180 + relay :3081)
if ! curl -sf -m 2 http://localhost:5180 >/dev/null 2>&1; then
	echo "starting constellation dev server..."
	(cd "$CONSTELLATION" && nohup npm run dev >"$DIR/logs/dev.log" 2>&1 & echo $! >"$DIR/logs/dev.pid")
fi
wait_http http://localhost:5180 90
wait_http http://localhost:3081/healthz 90
echo "constellation up (game :5180, relay :3081)"

# 2. harness deps
if [[ ! -d "$DIR/node_modules" ]]; then
	echo "installing harness deps..."
	(cd "$DIR" && npm install --no-fund --no-audit)
fi

# 3. drivers (replace any stale ones)
curl -s -m 3 -X POST http://127.0.0.1:4801/shutdown >/dev/null 2>&1 || true
curl -s -m 3 -X POST http://127.0.0.1:4802/shutdown >/dev/null 2>&1 || true
sleep 1
node "$DIR/driver/laptop.mjs" >"$DIR/logs/laptop-driver.log" 2>&1 & echo $! >"$DIR/logs/laptop-driver.pid"
node "$DIR/driver/phone.mjs" >"$DIR/logs/phone-driver.log" 2>&1 & echo $! >"$DIR/logs/phone-driver.pid"
wait_http http://127.0.0.1:4801/health 30
wait_http http://127.0.0.1:4802/health 30
echo "drivers up (laptop :4801, phone :4802)"

if [[ $MODE == drivers ]]; then
	echo "drivers-only mode — leaving everything running"
	exit 0
fi

# 4. preflight: one cheap request per player model — free-tier quotas are DAILY
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

# 5. two player sessions
RUNID="$(date +%Y%m%d-%H%M%S)"
CHANNEL="playtest-$RUNID"
render() { sed -e "s/__CHANNEL__/$CHANNEL/g" -e "s/__RUNID__/$RUNID/g" -e "s|__DIR__|$DIR|g" "$1"; }
render "$DIR/prompts/laptop.md" >"$DIR/logs/$RUNID-prompt-laptop.txt"
render "$DIR/prompts/phone.md" >"$DIR/logs/$RUNID-prompt-phone.txt"

echo "launching player sessions (run $RUNID, channel $CHANNEL)"
echo "  laptop: $LAPTOP_MODEL   phone: $PHONE_MODEL"
(cd "$PI_ROOT" && ./pi-test.sh -p -nc -a --model "$LAPTOP_MODEL" -n "playtest-laptop-$RUNID" \
	"$(cat "$DIR/logs/$RUNID-prompt-laptop.txt")" >"$DIR/logs/$RUNID-session-laptop.log" 2>&1) &
LAPTOP_PID=$!
(cd "$PI_ROOT" && ./pi-test.sh -p -nc -a --model "$PHONE_MODEL" -n "playtest-phone-$RUNID" \
	"$(cat "$DIR/logs/$RUNID-prompt-phone.txt")" >"$DIR/logs/$RUNID-session-phone.log" 2>&1) &
PHONE_PID=$!

deadline=$((SECONDS + PILOT_TIMEOUT_S))
while kill -0 "$LAPTOP_PID" 2>/dev/null || kill -0 "$PHONE_PID" 2>/dev/null; do
	if ((SECONDS > deadline)); then
		echo "TIMEOUT after ${PILOT_TIMEOUT_S}s — killing player sessions" >&2
		kill "$LAPTOP_PID" "$PHONE_PID" 2>/dev/null || true
		break
	fi
	sleep 5
done
wait "$LAPTOP_PID" 2>/dev/null || true
wait "$PHONE_PID" 2>/dev/null || true

# 6. teardown drivers (keep the dev server; teardown mode stops it). The curls
# are the polite path; the pid files catch a driver whose command chain wedged.
curl -s -m 5 -X POST http://127.0.0.1:4801/shutdown >/dev/null 2>&1 || true
curl -s -m 5 -X POST http://127.0.0.1:4802/shutdown >/dev/null 2>&1 || true
sleep 1
stop_pidfile "$DIR/logs/laptop-driver.pid"
stop_pidfile "$DIR/logs/phone-driver.pid"

echo
echo "run $RUNID finished. reports:"
ls -la "$DIR/reports" 2>/dev/null | grep "$RUNID" || echo "  (none written — check logs/$RUNID-session-*.log)"
