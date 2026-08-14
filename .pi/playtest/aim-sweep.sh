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
elif isinstance(d, bool): print("true" if d else "false")
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

	# Preconditions are checked, not assumed. A trial that runs at an unbridged
	# pit, or without the freeze that gets it through the patrol band, produces a
	# TRIAL line indistinguishable from a valid one — and these lines are the
	# dataset a decision gets made from. Label the failure in the log instead.
	local fz
	if ! bank_platform; then
		printf 'TRIAL\t%s\tV=%s\tcut=%s\trep=%s\tSKIPPED — no bridge (summon-platform left platformCount=0)\n' \
			"$block" "$v" "$cut" "$rep"
		return
	fi
	fz="$(solve freeze-stars)"
	if [[ "$(field "$fz" solved)" != true ]]; then
		printf 'TRIAL\t%s\tV=%s\tcut=%s\trep=%s\tSKIPPED — freeze did not land (solved=%s)\n' \
			"$block" "$v" "$cut" "$rep" "$(field "$fz" solved)"
		return
	fi

	local mv se body ev x y died pc tf tracer pk=""
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
	# The driver's own answers to the two questions this sweep had to reconstruct
	# from the trace: did the jump actually take off, and what was the astronaut
	# last standing on. Recorded ALONGSIDE the trace, never instead of it — the
	# trace is polled from /state and owes nothing to /move, so the summary can
	# check one against the other.
	local took apexy stood
	took="$(field "$mv" jump.tookOff)"; apexy="$(field "$mv" jump.apexY)"
	stood="$(field "$mv" lastStoodAt)"; [[ -z $stood ]] && stood="$(field "$se" lastStoodAt)"
	x="$(field "$s" state.x)"; y="$(field "$s" state.y)"; pc="$(field "$s" state.platformCount)"
	printf 'TRIAL\t%s\tV=%s\tcut=%s\trep=%s\t%s\tevents=%s\tdiedAt=%s\tx=%s\ty=%s\tplat=%s\tfreeze=%sms\ttookOff=%s\tapexY=%s\tstood=%s\t%s\t%s\n' \
		"$block" "$v" "$cut" "$rep" "${pk:-park=none}" "$ev" "${died:-none}" "$x" "$y" "$pc" \
		"$(field "$fz" elapsedMs)" "${took:-none}" "${apexy:-none}" "${stood:-none}" \
		"$(classify "$ev" "$x" "$y" "$died")" "$(trace_summary "$tf")"
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

# --- summary ----------------------------------------------------------------
# The header promises one, and hand-tallying 68 TRIAL lines is how the first
# draft of the report shipped a Block C table that dropped a trial and miscounted
# the no-jump row (adversarial review F1). Every figure the report's own tables
# are built from is therefore derived here: per-cell trial and verdict counts,
# and the four outcome classes with their take-off spans (F11).
echo
echo "== summary =="
python3 - "$LOG" <<-'PY'
import re, sys, collections
rows, skipped = [], 0
for line in open(sys.argv[1]):
    if not line.startswith("TRIAL"): continue
    if "SKIPPED" in line: skipped += 1; continue
    f = line.rstrip("\n").split("\t")
    g = lambda k: (re.search(k + r"=(\S+)", line) or [None, None])[1]
    m = re.search(r"apex=\((\d+),(\d+)\)", line)
    t = g("takeoff")
    rows.append({
        "block": f[1], "V": g("V"), "cut": g("cut"), "park": g("park"),
        "rep": g("rep"),
        # What /move itself said, kept separate from everything the trace derived.
        "tookOff": {"true": True, "false": False}.get(g("tookOff")),
        "stoodY": (lambda s: int(s.split(",")[1]) if s and s != "none" else None)(g("stood")),
        "died": g("diedAt") not in (None, "none"),
        "takeoff": None if t in (None, "None") else int(t),
        "apexy": int(m.group(2)) if m else None,
        "bridge": (lambda b: None if b in (None, "None") else int(b))(g("bridge")),
        "verdict": next(t for t in f if t.startswith(("FELL", "LAND", "DIED", "GROUND", "WON", "AIRBORNE"))).split("@")[0],
    })
print("trials=%d skipped=%d" % (len(rows), skipped))
for blk in sorted({r["block"] for r in rows}):
    br = [r for r in rows if r["block"] == blk]
    # A jump that never left the ground reads as an apex still at standing
    # height. The trace stays the authority for this even though /move now
    # reports a take-off verdict directly, because that is exactly the claim the
    # cross-check below is testing — scoring it against itself would prove
    # nothing.
    nojump = [r for r in br if r["apexy"] is not None and r["apexy"] >= 470]
    onbridge = [r for r in br if r["bridge"] is not None]
    # The four outcome classes the report's take-off table is built from. They
    # are counted here so that table is derived, not eye-counted off 48 rows —
    # which is the same failure mode that put a wrong Block C row in the first
    # draft, one table over.
    bonk = [r for r in br if r["apexy"] is not None and 380 <= r["apexy"] < 470]
    clean = [r for r in br if r["apexy"] is not None and r["apexy"] < 380]
    # Filter INSIDE the lambda, not just guard on "at least one is set": min()
    # over a list mixing int and None raises TypeError, which would abort the
    # whole summary — including the per-cell table below — on one bad trace.
    def span(rs):
        vs = [x["takeoff"] for x in rs if x["takeoff"] is not None]
        return "%s-%s" % (min(vs), max(vs)) if vs else "n/a"
    print("  block %s: n=%d  %s" % (blk, len(br), dict(collections.Counter(r["verdict"] for r in br))))
    print("    never left the ground: %-3d ceiling-bonked: %-3d clean jumps: %d" % (len(nojump), len(bonk), len(clean)))
    # A trial whose trace came back empty has no apex and so joins none of the
    # three classes above. Say so out loud — silently absorbing it is exactly the
    # miscount this summary exists to prevent.
    unclassified = len(br) - len(nojump) - len(bonk) - len(clean)
    if unclassified:
        print("    UNCLASSIFIED (no trace): %d — the three classes above do not sum to n" % unclassified)
    print("      bonked take-offs %s (apexY %s)" % (
        span(bonk), sorted({r["apexy"] for r in bonk}) or "-") if bonk else "      bonked: none")
    cb = [r for r in clean if r["bridge"] is not None]
    cm = [r for r in clean if r["bridge"] is None]
    if cb: print("      clean + touched bridge: %-3d take-offs %s  touchdown %s-%s" % (
        len(cb), span(cb), min(r["bridge"] for r in cb), max(r["bridge"] for r in cb)))
    if cm: print("      clean + missed bridge:  %-3d take-offs %s" % (len(cm), span(cm)))
    print("    touched the bridge (any class): %d" % len(onbridge))
    keys = collections.OrderedDict()
    for r in br:
        keys.setdefault((r["V"], r["cut"], r["park"]), []).append(r)
    for (v, cut, park), rs in keys.items():
        print("    V=%-4s cut=%-4s park=%-14s n=%d  %s  nojump=%d bridge=%d" % (
            v, cut, park, len(rs), dict(collections.Counter(r["verdict"] for r in rs)),
            sum(1 for r in rs if r["apexy"] is not None and r["apexy"] >= 470),
            sum(1 for r in rs if r["bridge"] is not None)))

# The point of the re-run: does /move's own telemetry say what the trace says?
# The two are independent — the trace is polled from /state throughout the move,
# while tookOff/lastStoodAt are computed inside /move's poll loop — so a
# disagreement is a real defect in one of them and gets printed per trial rather
# than folded into a rate.
print()
print("== driver telemetry vs trace ==")
judged = [r for r in rows if r["tookOff"] is not None and r["apexy"] is not None]
disagree = [r for r in judged if r["tookOff"] != (r["apexy"] < 470)]
print("take-off verdict: %d trials judged, %d agree, %d disagree" % (
    len(judged), len(judged) - len(disagree), len(disagree)))
for r in disagree:
    print("  DISAGREE block %s V=%s cut=%s rep=%s: /move said tookOff=%s, trace apexY=%s" % (
        r["block"], r["V"], r["cut"], r["rep"], r["tookOff"], r["apexy"]))
notook = [r for r in rows if r["tookOff"] is None]
if notook:
    print("  no take-off verdict: %d (never reached the jump x, or the move ended"
          " too soon after the press to tell)" % len(notook))
# A trial with a verdict but an empty trace joins neither side of the comparison.
# Saying so is the same rule the UNCLASSIFIED line above follows: a trial that
# falls out of every bucket gets named, never silently absorbed.
untraced = [r for r in rows if r["tookOff"] is not None and r["apexy"] is None]
if untraced:
    print("  verdict but no trace to check it against: %d" % len(untraced))
# Follow-up 2: the 19 correctly-aimed jumps that landed and then walked off must
# stop looking like plain pit deaths. The trace says which trials touched the
# bridge; lastStoodAt has to agree, by reporting the bridge's standing height
# (429) rather than the ground's (476).
print("last surface stood on, by whether the trace saw a bridge rest:")
for touched in (True, False):
    rs = [r for r in rows if (r["bridge"] is not None) == touched and r["stoodY"] is not None]
    if rs:
        print("  bridge in trace=%-5s n=%-3d stoodY %s" % (
            touched, len(rs), dict(collections.Counter(r["stoodY"] for r in rs))))
# Only a DEATH is supposed to carry lastStoodAt, so counting every trial without
# one reports the block-B landings — trials that ended alive — as missing
# telemetry. Count the trials that actually died and got nothing.
nostood = [r for r in rows if r["died"] and r["stoodY"] is None]
print("  died with no lastStoodAt: %d   (ended alive, so none is owed: %d)" % (
    len(nostood), sum(1 for r in rows if not r["died"])))
PY

echo
echo "sweep complete — $LOG"
