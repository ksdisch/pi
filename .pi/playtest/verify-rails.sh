#!/usr/bin/env bash
# Rails verification (DESIGN.md step 1): a scripted two-client planet-1 clear
# through both drivers, no LLM. Run `./run-pilot.sh drivers` first.
# NOTE: this file encodes the planet-1 solution — player prompts must never
# reference it; the players are supposed to discover the level themselves.
set -uo pipefail
L=http://127.0.0.1:4801
P=http://127.0.0.1:4802

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
