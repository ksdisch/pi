#!/usr/bin/env bash
# Planet-1 aim sweep — the experiment pilot 4 could not run (PILOT-2026-08-13.md
# finding 2). Scripted, no LLM: sweep `jumpAtX` across the pit and record which
# values land and which fall, so "can a correctly-aimed pair clear the pit" stops
# being an open question. Run `./run-pilot.sh drivers` first.
#
# NOTE: like verify-rails.sh, this file encodes the planet-1 solution — player
# prompts must never reference it. It is not a seat; seats discover the level.
#
# Output: one TRIAL line per attempt, tab-separated, plus a summary. Everything
# is tee'd to logs/<date>-aim-sweep.log so the numbers stay checkable (the gap
# PILOT-2026-08-13.md's appendix flags for verify-rails.sh).
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_ENV="$(node "$DIR/driver/ports.mjs" --env)" ||
	{ echo "ERROR: could not derive driver ports — is node on PATH? ($DIR/driver/ports.mjs)" >&2; exit 1; }
eval "$PORT_ENV"
L="http://127.0.0.1:${LAPTOP_DRIVER_PORT:-$PI_PLAYTEST_LAPTOP_PORT}"
P="http://127.0.0.1:${PHONE_DRIVER_PORT:-$PI_PLAYTEST_PHONE_PORT}"

mkdir -p "$DIR/logs"
LOG="$DIR/logs/$(date +%Y%m%d-%H%M%S)-aim-sweep.log"
exec > >(tee "$LOG") 2>&1
echo "aim sweep — log: $LOG"

# Same guard as verify-rails.sh: never drive a driver this checkout does not own.
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

move() { curl -s -m 40 -X POST "$L/move" -d "$1"; }
solve() { curl -s -m 60 -X POST "$P/solve" -d "{\"power\":\"$1\"}"; }
state() { curl -s -m 20 "$L/state"; }

# Pull one field out of a /move or /state reply. `state.x` etc. are dotted.
# A coordinate object ({x,y}, like `diedAt`) comes back as "x,y" so the callers
# can slice it with ${v%,*} / ${v#*,} instead of a second python hop.
field() { # json path
	printf '%s' "$1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for k in sys.argv[1].split("."):
    if d is None: break
    d = d.get(k) if isinstance(d, dict) else None
if d is None: print("")
elif isinstance(d, dict) and "x" in d: print(str(d["x"]) + "," + str(d["y"]))
elif isinstance(d, list): print(",".join(map(str, d)))
else: print(d)
' "$2"
}

# --- geometry, for classifying an outcome -----------------------------------
# From constellation src (read-only; the harness never edits that repo):
#   ground tiles 64x40 centred at x = 32+64k, y=520  -> top y=500, so the
#     astronaut (32x48) stands at centre y=476. Tiles are skipped for
#     660 <= x < 880, so the real gap is 640..896 and the fall edge is x=656.
#   summoned platform 96x14 at (770,460)             -> top y=453, stand y=429
#   hidden platform  120x16 at (920,420)             -> top y=412, stand y=388
#   corridor ceiling 400x20 at (420,360)             -> spans x 220..620
# y alone therefore says WHAT the astronaut is standing on, with no arithmetic.
# The ceiling is why the sweep starts where it does: a jump (v0 -460, g 900)
# lifts the astronaut's head to the ceiling's underside ~55px after take-off, so
# a jump begun much left of ~580 bonks it and falls short. The sweep deliberately
# spans both sides of that, so "too early" is measured rather than assumed.
classify() { # events x y diedAt
	local ev="$1" x="$2" y="$3" died="$4"
	case "$ev" in
	*won*) echo "WON"; return ;;
	esac
	if [[ -n $died ]]; then
		local dy=${died#*,}
		if ((dy > 520)); then echo "FELL-pit"
		else echo "DIED-ground@${died%,*}"; fi
		return
	fi
	if ((y >= 415 && y <= 443)); then echo "LAND-platform@$x"
	elif ((y >= 374 && y <= 402)); then echo "LAND-hidden@$x"
	elif ((y >= 462 && y <= 490)); then
		if ((x > 880)); then echo "LAND-farledge@$x"; else echo "GROUND-near@$x"; fi
	else echo "AIRBORNE-y$y@$x"; fi
}

# --- setup ------------------------------------------------------------------
code="$(curl -s -m 40 -X POST "$L/boot" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("roomCode",""))')"
[[ -n $code ]] || { echo "boot failed"; exit 1; }
echo "room code: $code"
curl -s -m 30 -X POST "$P/join" -d "{\"code\":\"$code\"}" >/dev/null
curl -s -m 300 -X POST "$L/await-phone" >/dev/null
st="$(curl -s -m 30 -X POST "$L/planet" -d '{"id":"planet-1"}')"
echo "planet-1: x=$(field "$st" state.x) y=$(field "$st" state.y)"

# Reset by restarting the scene, not by walking home. `startPlanet` is a
# `scene.start('Planet', …)` (constellation Planet.ts startPlanetById), so every
# trial begins from an identical level: astronaut at spawn, respawnCount 0, NO
# platform, enemy back at the start of its patrol.
#
# Walking home is not good enough here, and the smoke run proved why: a bare
# jump that flies over the bridge grazes its top face on the way past, which
# ARMS it (Planet.ts armPlatform fires from the collider whenever the astronaut's
# feet are within 2px of the top). The bridge then silently expires 5s later,
# mid-flight, in a trial that believed it had banked one.
reset_scene() {
	curl -s -m 30 -X POST "$L/planet" -d '{"id":"planet-1"}' >/dev/null
}

platform_alive() { [[ "$(field "$(state)" state.platformCount)" -gt 0 ]]; }

# Bank a fresh UNARMED platform into the just-restarted scene. Unarmed platforms
# wait indefinitely, so this one is guaranteed to still be standing when the
# jump reaches it.
bank_platform() {
	solve summon-platform >/dev/null
	platform_alive || { echo "  WARNING: summon-platform left platformCount=0"; return 1; }
}

# --- one trial --------------------------------------------------------------
# One move, from spawn, under a fresh freeze: run right and jump once on
# crossing `V`. The driver polls at 60ms, so the jump actually fires somewhere in
# [V, V+14] at the 240px/s run speed — every jump x below is that interval, not a
# point, and the band edges are reported as intervals because of it.
# Summarise a trajectory trace into the three numbers that say what happened:
# where the jump actually left the ground, how high it got, and where it crossed
# back below ground level (y>500 = past the top of the ground tiles, i.e. into
# the pit). `diedAt` alone cannot separate "bonked the ceiling and dropped in at
# x=700" from "flew the whole way and dropped in at x=850" — both drift right
# while falling and can reach the same last-sampled point.
trace_summary() { # tracefile
	python3 - "$1" <<-'PY'
	import json, sys
	xs = []
	base = None
	for line in open(sys.argv[1]):
	    line = line.strip()
	    if not line: continue
	    try: s = json.loads(line)["state"]
	    except Exception: continue
	    # Cut the trace at the death: everything after it is the RESPAWN sitting
	    # at spawn, and letting those samples in makes "highest point reached"
	    # come back as the spawn point.
	    if base is None: base = s["respawnCount"]
	    if s["respawnCount"] > base: break
	    xs.append((s["x"], s["y"]))
	if not xs:
	    print("trace=none"); raise SystemExit
	apex = min(xs, key=lambda p: p[1])
	upto = xs[: xs.index(apex) + 1]
	takeoff = next((p[0] for p in reversed(upto) if p[1] >= 470), None)
	# RESTING on a surface, not passing through its height. Sampling is ~65ms and
	# a descent covers ~26px in that time, so a fly-through leaves at most one
	# sample inside a 28px band while standing leaves several. Two consecutive is
	# the discriminator — without it, every jump "lands on the bridge" twice.
	#
	# The x window is not decoration: near the apex the astronaut is barely moving
	# vertically, so several consecutive samples fall inside ANY height band it
	# happens to top out in. A first pass reported "rested on the hidden platform"
	# at x=644 — 200px left of that platform — purely from apex dwell.
	def rest(lo, hi, x0, x1):
	    run = 0
	    for i, (x, y) in enumerate(xs):
	        if lo <= y <= hi and x0 <= x <= x1:
	            run += 1
	            if run == 2: return xs[i - 1][0]
	        else: run = 0
	    return None
	# x windows are the surface's own span widened by the astronaut's 16px half
	# width, since it rests there with either foot overhanging.
	bridge = rest(415, 443, 706, 834)   # summoned platform 722..818, stand y=429
	hidden = rest(374, 402, 844, 996)   # hidden platform   860..980, stand y=388
	far    = rest(462, 490, 880, 960)   # ground past the pit 896..960, stand y=476
	fell = next((p for p in xs if p[1] > 500 and p[0] > 640), None)
	print("n=%d takeoff=%s apex=(%s,%s) bridge=%s hidden=%s farledge=%s fellAt=%s end=(%s,%s)" % (
	    len(xs), takeoff, apex[0], apex[1], bridge, hidden, far,
	    ("%s,%s" % fell) if fell else "none", xs[-1][0], xs[-1][1]))
	PY
}

trial() { # block V cut rep [park]
	local block="$1" v="$2" cut="$3" rep="$4" park="${5:-none}"
	reset_scene
	bank_platform

	local fz mv se body ev x y died pc tf tracer pk=""
	fz="$(solve freeze-stars)"
	# Optional stage 1: run to the pit lip and stop, then jump from a standing
	# start. This is the two-stage plan pilot-4's run B invented for itself
	# (PILOT-2026-08-13.md, "The pair found the right plan"), so it is worth
	# measuring as its own maneuver rather than inferring it from the one-move
	# blocks. Stage 2's `ms` then covers only the jump.
	if [[ $park != none ]]; then
		pk="$(move "{\"dir\":\"right\",\"ms\":4000,\"untilX\":$park}")"
		pk="park=$(field "$pk" state.x)/$(field "$pk" events)"
	fi
	body="{\"dir\":\"right\",\"ms\":4500,\"jumpAtX\":$v"
	[[ $cut != none ]] && body="$body,\"untilX\":$cut"
	body="$body}"
	# `/state` is registered off the driver's serial command chain (laptop.mjs
	# startServer's third argument), so it answers while a /move is still running
	# — that is what makes a live trajectory trace possible at all.
	tf="$(mktemp)"
	while :; do curl -s -m 2 "$L/state"; echo; sleep 0.05; done >"$tf" 2>/dev/null &
	tracer=$!
	mv="$(move "$body")"
	# A `reached-x` cut leaves the astronaut airborne, so the outcome is not
	# decided until it comes down — the settle move is where a cut jump either
	# lands on the bridge or falls past it, and its events count as this trial's.
	se="$(move '{"dir":"none","ms":900}')"
	kill "$tracer" 2>/dev/null; wait "$tracer" 2>/dev/null
	local s; s="$(state)"
	ev="$(field "$mv" events)|$(field "$se" events)"
	died="$(field "$mv" diedAt)"; [[ -z $died ]] && died="$(field "$se" diedAt)"
	x="$(field "$s" state.x)"; y="$(field "$s" state.y)"; pc="$(field "$s" state.platformCount)"
	printf 'TRIAL\t%s\tV=%s\tcut=%s\trep=%s\t%s\tevents=%s\tdiedAt=%s\tx=%s\ty=%s\tplat=%s\tfreeze=%sms\t%s\t%s\n' \
		"$block" "$v" "$cut" "$rep" "${pk:-park=none}" "$ev" "${died:-none}" "$x" "$y" "$pc" \
		"$(field "$fz" elapsedMs)" "$(classify "$ev" "$x" "$y" "$died")" "$(trace_summary "$tf")"
	rm -f "$tf"
}

# --- block A: bare jumpAtX, platform banked ---------------------------------
# The question finding 2 left open. A bare jumpAtX with no untilX is what both
# pilot-4 seats actually issued; this asks which values of it work.
echo
echo "== block A — bare jumpAtX (no untilX), platform banked =="
for v in ${SWEEP_A_VALUES:-566 574 582 590 598 606 614 622 630 638 646 654}; do
	for rep in $(seq 1 "${SWEEP_A_REPS:-4}"); do trial A "$v" none "$rep"; done
done

# --- block B: the rails pairing ---------------------------------------------
# jumpAtX WITH an untilX over the platform — the maneuver verify-rails.sh uses.
# Cutting input mid-flight zeroes velocityX (Astronaut sets it from input every
# frame, airborne included), so the astronaut drops where the cut happened.
echo
echo "== block B — jumpAtX + untilX:780, platform banked =="
for v in ${SWEEP_B_VALUES:-574 598 626 650}; do
	for rep in $(seq 1 "${SWEEP_B_REPS:-2}"); do trial B "$v" 780 "$rep"; done
done

# --- block C: the plan the pair actually invented ----------------------------
# Park at the lip under freeze, then jump from a standing start — pilot-4 run B's
# own two-stage plan. Does the maneuver the seats converged on work bare?
echo
echo "== block C — park at the lip, then jump (two-stage), platform banked =="
for park in ${SWEEP_C_PARKS:-620 630 640}; do
	for rep in $(seq 1 "${SWEEP_C_REPS:-2}"); do
		trial C "$((park - 20))" none "$rep" "$park"
		trial C "$((park - 20))" 780 "cut$rep" "$park"
	done
done

echo
echo "sweep complete — $LOG"
