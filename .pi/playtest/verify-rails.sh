#!/usr/bin/env bash
# Rails verification (DESIGN.md step 1): a scripted two-client planet-1 clear
# through both drivers, no LLM. Run `./run-pilot.sh drivers` first.
# NOTE: this file encodes the planet-1 solution — player prompts must never
# reference it; the players are supposed to discover the level themselves.
set -uo pipefail
# Same env names the drivers read, so an override moves both sides together.
L="http://127.0.0.1:${LAPTOP_DRIVER_PORT:-4801}"
P="http://127.0.0.1:${PHONE_DRIVER_PORT:-4802}"

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

# Platform trigger, in its hardest shape: arm while a platform is still ALIVE
# (the trigger's floor starts at 1), let it expire, re-cast, and confirm the
# rising edge fires from the lowered floor. A fixed arm-time baseline fails
# this exact sequence. The summoned platforms drop far away (~770); the
# stationary arm at ~150 never touches them, and no patrol reaches it.
solve summon-platform | python3 -c 'import sys,json;print("armed-check platform pre-cast:",json.load(sys.stdin)["solved"])'
armed_out=$(mktemp)
curl -s -m 60 -X POST $L/move -d '{"arm":{"on":"platform","timeoutMs":30000},"dir":"none","ms":300}' >"$armed_out" &
armed_pid=$!
sleep 6
solve summon-platform | python3 -c 'import sys,json;print("armed-check platform re-cast:",json.load(sys.stdin)["solved"])'
wait "$armed_pid"
amv=$(cat "$armed_out")
rm -f "$armed_out"
echo "armed platform: $(echo "$amv" | pp) armedForMs=$(echo "$amv" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("armedForMs"))')"
echo "$amv" | grep -q arm-fired || { echo "armed platform trigger did not fire on the re-cast — rails NOT verified"; exit 1; }
# Let the re-cast platform expire (5s lifetime) so attempt 1's own summon
# isn't swallowed by the game's one-live-platform cap.
sleep 4

for attempt in 1 2 3 4 5 6; do
	echo "=== attempt $attempt"
	# freeze the sentry (patrols ~280-560), dash from spawn, park at 620 (safe: pit lip at ~640)
	solve freeze-stars | python3 -c 'import sys,json;print("  freeze:",json.load(sys.stdin)["solved"])'
	mv=$(move '{"dir":"right","ms":4000,"untilX":620}')
	echo "  corridor: $(echo "$mv" | pp)"
	echo "$mv" | grep -q reached-x || continue

	# summon the platform (drops at 770 over the 640-864 void), leap onto it from the lip
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
