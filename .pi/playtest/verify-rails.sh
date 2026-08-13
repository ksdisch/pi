#!/usr/bin/env bash
# Rails verification (DESIGN.md step 1): a scripted two-client planet-1 clear
# through both drivers, no LLM. Run `./run-pilot.sh drivers` first.
# NOTE: this file encodes the planet-1 solution — player prompts must never
# reference it; the players are supposed to discover the level themselves.
set -uo pipefail
# Same env names the drivers read, so an override moves both sides together;
# the defaults come from driver/ports.mjs, which derives them from this
# checkout's path so a second checkout's drivers are unreachable from here.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ENV="$(node "$DIR/driver/ports.mjs" --env)" ||
	{ echo "ERROR: could not derive driver ports — is node on PATH? ($DIR/driver/ports.mjs)" >&2; exit 1; }
eval "$PORT_ENV"
L="http://127.0.0.1:${LAPTOP_DRIVER_PORT:-$PI_PLAYTEST_LAPTOP_PORT}"
P="http://127.0.0.1:${PHONE_DRIVER_PORT:-$PI_PLAYTEST_PHONE_PORT}"

# Never drive a driver this checkout does not own: a neighbouring checkout's
# drivers answering on these ports would run this whole script against their
# game, which is how pilot 3 produced a phantom clear.
assert_owned() { # url
	local owner
	owner="$(curl -sf -m 3 "$1/health" 2>/dev/null | sed -n 's/.*"harnessDir":"\([^"]*\)".*/\1/p' || true)"
	[[ $owner == "$PI_PLAYTEST_HARNESS_DIR" ]] && return 0
	echo "ERROR: $1 is not this checkout's driver (harnessDir=${owner:-none}, expected $PI_PLAYTEST_HARNESS_DIR)" >&2
	echo "Start this checkout's drivers with ./run-pilot.sh drivers first." >&2
	exit 1
}
assert_owned "$L"
assert_owned "$P"

move() { curl -s -m 40 -X POST $L/move -d "$1"; }
solve() { curl -s -m 60 -X POST $P/solve -d "{\"power\":\"$1\"}"; }
pp() { python3 -c 'import sys,json;d=json.load(sys.stdin);s=d.get("state",{});print(d.get("events"),"x",s.get("x"),"y",s.get("y"),"resp",s.get("respawnCount"),"won",s.get("won"))'; }

boot() {
	local code
	code=$(curl -s -m 40 -X POST $L/boot | python3 -c 'import sys,json;print(json.load(sys.stdin)["roomCode"])') || return 1
	echo "room code: $code"
	curl -s -m 30 -X POST $P/join -d "{\"code\":\"$code\"}" |
		python3 -c 'import sys,json;print("phone:",json.load(sys.stdin)["screen"])'
	curl -s -m 300 -X POST $L/await-phone >/dev/null
	curl -s -m 30 -X POST $L/planet -d '{"id":"planet-1"}' | pp
}

boot || { echo "boot/pairing failed"; exit 1; }

# Exercise the trivia executor while parked safely at spawn (illuminate is
# perceptual — the clear below doesn't depend on it).
solve illuminate | python3 -c 'import sys,json;d=json.load(sys.stdin);print("illuminate:",d["solved"],[t["question"][:40] for t in d["transcript"]])'

# Armed-move check: pre-commit a short dash on the freeze trigger, cast freeze
# after a beat, and confirm the driver held the move until the cast landed
# (arm-fired) instead of timing out. The dash stays in the safe zone left of
# the sentry patrol (~280+); walk back after so the attempts start spawn-side.
armed_out=$(mktemp)
curl -s -m 60 -X POST $L/move -d '{"arm":{"on":"freeze","timeoutMs":30000},"dir":"right","ms":1000,"untilX":240}' >"$armed_out" &
armed_pid=$!
sleep 2
solve freeze-stars | python3 -c 'import sys,json;print("armed-check freeze:",json.load(sys.stdin)["solved"])'
wait "$armed_pid"
amv=$(cat "$armed_out")
rm -f "$armed_out"
echo "armed dash: $(echo "$amv" | pp) armedForMs=$(echo "$amv" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("armedForMs"))')"
echo "$amv" | grep -q arm-fired || { echo "armed move did not fire on the cast — rails NOT verified"; exit 1; }
# Retreat before the long platform check below: the dash overshoots untilX by
# up to ~14px, which can rest inside the sentry's reach (starts ~248), and the
# next block stands still unfrozen for 15-30s. x=150 is 130px clear.
move '{"dir":"left","ms":2500,"untilX":150}' >/dev/null

# Platform trigger: arm with no platform alive, then cast, and confirm the move
# fires on the 0 -> 1 rising edge. The summoned platform drops far away (~770);
# the stationary arm at ~150 never touches it, and no patrol reaches it.
#
# This block used to test a harder shape — arm while a platform was ALIVE, let
# it expire, re-cast, and watch the edge fire from the lowered floor (a fixed
# arm-time baseline fails exactly that). Constellation b7c308a ("summoned
# platform arms on arrival, not on drop") made that sequence unreachable: a
# platform now lives until the astronaut touches it, and a re-cast while one is
# alive is a deliberate no-op, so the count cannot fall and rise again without a
# full traverse. The driver's floor tracking stays as it is — a platform that IS
# crossed still expires and lowers the count mid-run.
#
# The driver's platform trigger now reads the LEVEL (a platform exists) rather
# than a rising edge, for the same reason the freeze trigger always has: a human
# who sees a bridge already standing just goes. Edge-triggering could not survive
# the new lifetime rule anyway — a seat arming after its partner banked the
# platform would wait out the whole timeout on an edge that can never come. This
# check therefore starts with no platform alive, so it still exercises a real
# 0 -> 1 arrival rather than an instant fire.
armed_out=$(mktemp)
curl -s -m 60 -X POST $L/move -d '{"arm":{"on":"platform","timeoutMs":30000},"dir":"none","ms":300}' >"$armed_out" &
armed_pid=$!
sleep 2
solve summon-platform | python3 -c 'import sys,json;print("armed-check platform cast:",json.load(sys.stdin)["solved"])'
wait "$armed_pid"
amv=$(cat "$armed_out")
rm -f "$armed_out"
echo "armed platform: $(echo "$amv" | pp) armedForMs=$(echo "$amv" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("armedForMs"))')"
echo "$amv" | grep -q arm-fired || { echo "armed platform trigger did not fire on the cast — rails NOT verified"; exit 1; }

for attempt in 1 2 3 4 5 6; do
	echo "=== attempt $attempt"
	# freeze the sentry (patrols ~280-560), dash from spawn, park at 620 (safe: pit lip at ~640)
	solve freeze-stars | python3 -c 'import sys,json;print("  freeze:",json.load(sys.stdin)["solved"])'
	mv=$(move '{"dir":"right","ms":4000,"untilX":620}')
	echo "  corridor: $(echo "$mv" | pp)"
	echo "$mv" | grep -q reached-x || continue

	# Make sure a platform is in place over the 640-864 void (it drops at 770 and
	# now waits there until stepped on, so this cast is a no-op when the check
	# above already dropped one), then leap onto it from the lip.
	solve summon-platform | python3 -c 'import sys,json;d=json.load(sys.stdin);print("  platform:",d["solved"],"in",d["elapsedMs"],"ms")'
	mv=$(move '{"dir":"right","ms":2000,"jumpAtX":628,"untilX":780}')
	echo "  leap1: $(echo "$mv" | pp)"
	echo "$mv" | grep -q respawned && continue
	mv=$(move '{"dir":"none","ms":500}')
	echo "  settle: $(echo "$mv" | pp)"
	echo "$mv" | grep -q respawned && continue

	# leap from the platform lip toward the goal ledge
	mv=$(move '{"dir":"right","ms":1500,"jumpAtX":806,"untilX":900}')
	echo "  leap2: $(echo "$mv" | pp)"
	echo "$mv" | grep -q '"won":true' && { echo "WON on attempt $attempt"; exit 0; }
	echo "$mv" | grep -q respawned && continue
	mv=$(move '{"dir":"none","ms":600}')
	echo "  settle2: $(echo "$mv" | pp)"
	echo "$mv" | grep -q '"won":true' && { echo "WON on attempt $attempt"; exit 0; }

	# on the far ledge — hop up under the goal
	for burst in 1 2 3; do
		mv=$(move '{"dir":"right","ms":1800,"hop":true,"untilX":918}')
		echo "  hop-up $burst: $(echo "$mv" | pp)"
		echo "$mv" | grep -q '"won":true' && { echo "WON on attempt $attempt"; exit 0; }
		echo "$mv" | grep -q respawned && break
	done
done
echo "no clear in 6 attempts — rails NOT verified"
exit 1
