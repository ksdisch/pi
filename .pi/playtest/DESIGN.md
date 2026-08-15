# Co-op Playtest Harness — v1 Design

## What this is

Two pi sessions playtest Constellation like two humans on a couch: one drives the
laptop platformer view, one the phone puzzle view, coordinating in real time over
the intercom extension, then each writes up what the game felt like. The output
Kyle cares about is the **critique report**, not the clear itself.

Pilot scope (locked): **one planet** (planet-1), two players, one run.

## Where it lives, and why

`.pi/playtest/` in this fork — beside the extensions it composes with.

- **Not the constellation repo:** its stack is explicitly locked — "no Playwright
  dependency" (docs/AUTONOMY.md). This harness is Playwright-based by necessity.
  v1 is **zero-diff on constellation**: nothing there changes, not even the bridge.
- **Not a pi extension:** player sessions only need bash + read/write + intercom.
  Game-driving happens in ordinary node processes; wrapping them as pi tools adds
  surface without adding capability.
- Plain-JS `.mjs` + its own `package.json`, so pi's typecheck/CI never sees it.

## Architecture

```
 pi session "laptop"  ── bash/curl ──▶  laptop driver ──▶ Chromium: game ?test=1
        │ intercom (file channel, token-free waits)   │        │ ws :3081
 pi session "phone"   ── bash/curl ──▶  phone driver ─┘ ──▶ Chromium: phone.html
                                        (world glance)
```

Driver ports are derived per checkout (see "Port isolation"); the phone driver's
one call to the laptop driver is the world glance described below.

**One persistent Playwright driver process per view**, each owning a long-lived
headless Chromium page and speaking a tiny JSON-over-HTTP command surface on
localhost. The LLM never does frame-level control: **one agent turn = one batched
command** (a whole maneuver, a whole puzzle read), because free-tier Gemini gives
~5 requests/min/model and every LLM turn is precious. All polling, timing, and
retries live inside the driver, where they're free.

Room code discovery needs no game change: the driver hooks the game page's
websocket (`page.on('websocket')`) and reads the `room-created` frame.

### Laptop driver (`driver/laptop.mjs`, derived port)

| Command | Does |
|---|---|
| `POST /boot` | Launch browser → `?test=1` (co-op, no solo) → wait for Lobby → return `{roomCode}` |
| `POST /await-phone` | Block until the `phone-joined` frame (Hub starts) |
| `POST /planet {id}` | `startPlanet(id)` via bridge, wait for `sceneKey==='Planet'`, return state |
| `POST /state` | Compact `getState()` snapshot, plus `lastDeath` (see "The death sampler"). Runs off the serial command chain — it only reads the game, and the phone's world glance asks for it while this seat may be holding a 90s armed move. It does drain the sampler's queue into the driver, so a glance by either seat delivers the record to both |
| `POST /move {...}` | One maneuver: timed left/right, cadence `hop`, one-shot `jumpAtX` (jump at a gap's lip), optional `untilX`, hard `maxMs`; runs as a single in-page loop; returns `before` x/y, `state` after, `elapsedMs`, and events (`respawned`, `jumped`, `jump-ignored`, `won`, `reached-x`, `time-up`). A `jumpAtX` the driver reached and pressed adds `jump` (see "Jump outcomes" below); a death adds `diedAt`, and `lastStoodAt` when a rest was observed (see "Death sites"). Both follow `diedAt`'s omit-when-absent rule. Optional `arm` pre-commits the maneuver on a partner's cast (see "Armed moves" below) |
| `POST /screenshot` | PNG into `reports/shots/` |
| `POST /shutdown` | Close browser, exit |

**Honesty rule, enforced by tooling:** the laptop driver exposes **no cast
command**. In co-op mode every cast must come from the phone solving a real
puzzle, exactly like a human pair. (The bridge's `cast()` would silently bypass
the partner — that's a solo-verification affordance, not a co-op one.)

**Death sites (`diedAt`) — where it died, not where it restarted.** A `/move`
reply whose events include `respawned` (or `respawned-while-armed`) carries an
extra `diedAt: {x, y}`. `state` stays the post-respawn truth; `diedAt` is the
last position the driver observed while the respawn count was still the old one.

Why it exists: the game respawns in the same frame it increments
`respawnCount`, so any poll that notices a death already reads spawn
coordinates. Every pilot's seats therefore reported dying "at x=84/88/92" —
spawn is x=80 — and reasoned from it: pilot 3's laptop asked for Illuminate
against a dark zone 570px away from where it actually died. Three runs of seat
reasoning, and the first draft of pilot 3's own report, were built on respawn
positions read as death positions.

The `y` is what ends the misattribution, and cheaply: standing height (~476) means
something on the ground reached you, a much larger y means you were already
falling — pit, not sentry — with no reconstruction arithmetic in between. Two
real deaths from the acceptance run, on the same planet, minutes apart:
`diedAt {x: 496, y: 476}` (sentry, mid-patrol-band) and `diedAt {x: 776, y: 600}`
(pit). Both reported `state.x` of 84 and 88 — the respawn point, which is what
every seat before this change was reading.

Two accuracy notes, stated so reports can carry them rather than discover them:

- `diedAt` lags the true death by up to one 60ms poll, ~14px at the astronaut's
  240px/s. It is a measurement with a known bias, not a game-reported event; the
  game exposes no death position.
- On a fall it is where the **fall registered**, not the edge that was left: the
  astronaut keeps its horizontal speed all the way down, so the x is roughly
  half a second of travel past the lip (656 → 776 in the run above). The `y`
  says "fell"; the `x` bounds where the edge is, from the right.

**What it fell off (`lastStoodAt`) — the edge, not just the landing.** A death
also carries `lastStoodAt: {x, y}`: the last spot the driver observed the
astronaut **resting on a surface** during that move.

Why it exists: `diedAt` says a fall happened and roughly where it ended, but two
opposite outcomes end identically. The aim sweep took 48 jumps at planet-1's pit
and **19 of them landed on the bridge and then ran off its far edge** — correct
aim, correct power, killed by a move that kept holding *right* after touchdown.
Every one reported the same thing as a jump that never came near the bridge: a
pit `diedAt` around `{776, 600}`. `lastStoodAt` separates them by height alone,
with no arithmetic and no level knowledge: `{~820, 429}` is the bridge (its
standing height), `{~650, 476}` is the ground at the pit's lip.

Resting is inferred, because the game exposes no contact flag — `BridgeState`
carries `astronautY` and nothing about what is under the feet, and the harness is
zero-diff on constellation. The rule is **two consecutive samples at the same
height that were arrived at from above**. The second clause is load-bearing: near
a jump's apex the astronaut is barely moving vertically, so two samples there can
round to the same y, but the sample *before* them is always lower (larger y)
because it was still climbing, while a real landing is approached from higher up.
Without that test a bare jump over the bridge would report "last stood on"
somewhere in mid-air at apex height. Both halves are strict — the pair must match
exactly, and a first sample with no predecessor to compare against records
nothing — because a 1px slack admits the first sample of a fall, which covers
only ~1.6px in 60ms.

Measured over the 68-trial sweep at this build
(`logs/20260813-210539-aim-sweep.log`): of 59 deaths, 14 named the bridge (429)
and 36 the ground (476) — only those two values, none of the off-by-one readings
a 1px slack produced — and 9 named nothing.

Four limits, stated so reports carry them rather than discover them.

- It is the last *sampled* rest, so its `x` can be up to one poll (~14px) along
  the surface from where the astronaut actually left it — the same bias `diedAt`
  has, and the `y` is the part the bridge-vs-ground question turns on.
- **A rest needs three consecutive samples** (a matching pair plus the one before
  it), so a move whose astronaut leaves the ground inside its first two — by
  jumping or by running off an edge — reports nothing at all. That is every one
  of the nine silent deaths: block C's stage-two moves start parked at the lip
  with a `jumpAtX` 20px *behind* them, so the press fires on sample one and the
  window never closes. The rest that matters happened in the previous call, and
  the field is scoped to this one.
- When no rest is caught in this move, the answer can also be **stale rather than
  absent**: a move that rested early, then landed somewhere new too briefly to
  register, reports the earlier surface. The sweep has one trial where the driver
  and the trace disagree this way (`A V=606 rep=4`: driver `{608, 476}`, trace a
  bridge rest at 812) — though the trace is the likelier error there, since the
  same aim's other three repetitions show no bridge contact at an identical apex
  and the trace's bridge test is a 28px band sampled against a ~26px/sample
  descent. One disagreement in 15 either way; neither side is proven.
- It is absent entirely on a `respawned-while-armed` death: the arm wait tracks
  no surfaces, and an armed astronaut stands still, so `diedAt` is already the
  spot it stood in.

**The death sampler — a record for the falls no `/move` is there to see.** A
60ms watcher, installed in the page at `/boot`, keeps its own death record and
hands it to `/state` as `lastDeath`.

Why it exists: a `/move` reply can only report a death that happened inside that
move, and a fall outlives its move. Pilot 7's run A ended a move `reached-x` at
`{680, 483}` — 24px past the pit's lip, already below standing height, i.e.
mid-fall — and the astronaut hit the bottom about a second later while the seat
spent twelve seconds composing its next turn. `respawnCount` went up; no reply
anywhere carried a site. The seat announced "Crossed the pit! I'm at x=680",
named a screenshot `past-pit`, and wrote it into its notes. Ten such deaths
across pilots 6 and 7 carried **every** distance-as-progress misread those
pilots produced, while every one of pilot 7's 26 captured deaths was read
correctly. The seats can read a record; they had none to read.

It runs **continuously**, not only between moves, and that is what makes the
record worth having: the rest at the lip happens during the move, the fall
completes after it, and only an unbroken history holds both. A sampler that
suspended itself for each `/move` would resume airborne with no history and
report the very case it exists for as "never caught at rest". Staged against the
shipped code, the pilot-7 case now reads: `/move` returns `reached-x` at
`{684, 485}` with no `diedAt`, and `/state` 0.4s later carries
`lastDeath {x: 688, y: 585, lastStoodAt: {652, 476}, respawnCount: 1,
via: "sampler"}` — ground height at the lip, which is the harness saying "you
walked off and landed on nothing", the exact claim the misreads got wrong.

It observes and nothing else: no input, no scene control. A human on the couch
watching the screen already sees every death it records.

Four things about the record, stated so reports carry them:

- **Two observers, one `lastDeath`.** The `/move` loop and the sampler both see
  a death that happens inside a move, phased up to a poll apart. `lastDeath`
  only ever moves forward, keyed on `respawnCount`. On a tie the copy that names
  `lastStoodAt` wins, because that is the whole question the field answers and
  the two observers scope it differently; when both copies are equally
  informative the move's wins, being the one already in the seat's hand from the
  reply, and `/state` disagreeing with that reply about a single death is worse
  than useless. Pilot 8 run B's rc=7 is why the first clause exists: the move
  caught no rest and reported none, while the sampler had the astronaut standing
  on the bridge at `{800, 429}` — "fell off the bridge" and "never reached it"
  are exactly the two readings that record separates, and the naive rule threw
  the informative copy away. `via` says whose copy survived that tie (`"move"`
  or `"sampler"`), not who saw the death — both observers see most deaths, and
  the tie-break can keep the sampler's copy for a death the `/move` reply also
  reported in full. What the sampler *added* is therefore a different count: a
  death whose `respawnCount` appears on a `via=sampler` ledger line and on no
  `via=move` line, kept or not, which is how pilot 8's table is tallied.
- **`/planet` clears it.** A planet entry resets `respawnCount` to 0, so a
  surviving record would both outrank every death of the new run forever and
  read as fresh to a seat comparing counts. (This closes the `lastDeath`
  freshness inversion carried as a PR #21 review follow-up; the monotonic key
  above is what turned it from a nice-to-have into a correctness requirement.)
- **The sampler's `lastStoodAt` is scoped to the LIFE, not to a move.** Wider
  than `/move`'s, which is the point — and it inherits the same "stale rather
  than absent" limit stated above, one life wide instead of one move: a life
  that rested at the lip, cleared to a surface too briefly to register, then
  fell, reports the lip. Which scope `lastDeath` is carrying depends on which
  copy won the tie above, and `via` is how a reader tells: a `"move"` copy
  stays scoped to its one move, exactly like the `/move` reply it came from.
- **A death it could not place is visible as a gap, not as silence.** With no
  previous sample to name — the death landing on the sample right after a planet
  entry — it records nothing rather than guessing, and the caller sees
  `state.respawnCount` running ahead of `lastDeath.respawnCount`. Both prompts
  teach that comparison as the freshness check.

The rest test and the keep-the-previous-sample rule are deliberate copies of the
`/move` loop's rather than a shared helper: the two run in different evaluates,
and `/move`'s `diedAt`/`lastStoodAt` semantics are pinned by the 68-trial sweep
measured above, which a refactor would have to re-run.

**Jump outcomes (`jump`) — a verdict, not a keypress.** A `jumpAtX` the driver
actually pressed adds `jump: {tookOff, pressedAt: {x, y}, apexY}`, and the
`jumped` event now fires only when `tookOff` is true; an inert press reports
`jump-ignored`.

The old event was a lie in a specific, load-bearing case. The game grants a jump
only from the ground, so a press issued when the astronaut is already airborne —
past a pit's edge, say — does nothing at all. The driver polls at 60ms, which is
14px at the 240px/s run speed, so a `jumpAtX` set within ~14px of planet-1's fall
edge is usually first seen *after* the astronaut has left the ledge: all eight
aim-sweep trials at `jumpAtX` ≥ 646 reported `jumped` having never left the
ground, and pilot 4 burned a finding on the same ambiguity from the seat's side —
its run B could not tell an attempted jump from a no-jump because both replies
were identical. A seat cannot diagnose an aim it never got to test.

The verdict is the observed rise: a jump lifts ~26px inside one poll, so the
driver calls it a take-off once the astronaut is 8px above where the key went
down, and calls it ignored if 240ms pass without that. A press made while already
climbing is reported ignored immediately — climbing means airborne, and airborne
is precisely why the game refuses it. `apexY` is the highest point reached after
the press, which is also what tells a clean jump from one that clipped a ceiling.

The verdict claims only what was observed. `tookOff: false` means no rise was
seen, which is nearly always "already airborne" but also covers a granted jump
cut short inside a poll; it is never a claim about the cause, and the seat prompt
says so. A move that ends too soon after the press to tell reports `tookOff:
null` with no event rather than a guess — the wait for the rise is bounded by
what is left of the move's own budget, so `maxMs` stays the absolute ceiling the
serial command chain depends on. And because the verdict lands when the rise
resolves, its event can follow a terminal one (`["respawned", "jump-ignored"]`):
`events` is a set, and nothing in the harness reads it in order.

**Armed moves — the one latency affordance.** `/move` takes an optional
`arm: {on: "freeze"|"platform", timeoutMs}` (`timeoutMs` only tightens the 90s
ceiling, mirroring `maxMs` — a hold that outlived the caller's curl deadline
would wedge the seat's serial command chain): the astronaut stands still until
the trigger fires, waits a fixed ~200ms human-reaction pause, then runs the
pre-committed move. Both triggers read the **level**, not a rising edge:
`enemyFrozen` is on, or a platform exists. A human who sees the enemy already
frozen — or a bridge already standing over the pit — just goes. For the platform
that is also the only rule the game still supports: since constellation
`b7c308a` (refined by `d4f5a3c`) a summoned platform waits indefinitely until the
astronaut *lands* on it — a side clip or an underside bonk does not start the
countdown — and a re-cast onto one that is still waiting is banner-only, so an
edge-triggered arm placed *after* a partner banked
the platform (the flow that game change was built for) could never fire. It
would hold the full 90s ceiling and then report `arm-timeout`, which the player
prompt defines as "no cast came" — a driver manufacturing a coordination failure
that never happened. Why it exists: both pilots died on the cue-to-cast round trip — the run-2
pair invented the right "GO" protocol and still lost, because a ~3s freeze
window cannot contain a ~12s+ LLM turn, so the harness was effectively
playtesting with a reaction time no human has. Why it is still honest: it is
the phone driver's honesty split applied to this seat — the LLM owns strategy
(which maneuver, which trigger, when to arm, the intercom coordination), the
driver owns mechanics and timing. The reaction pause is pinned in the driver,
not caller-tunable, so an armed move models a human holding the key in
anticipation, never a frame-perfect script. And it cannot wash out the harness's
core finding: standing armed is standing still, so `respawned-while-armed`
deaths are the clean measurement of "the game punishes waiting for your
partner". Reports must label armed-move progress as driver-reflex, exactly like
puzzle mechanics.

### Phone driver (`driver/phone.mjs`, derived port)

| Command | Does |
|---|---|
| `POST /join {code}` | Open phone.html, enter code, return spellbook summary |
| `POST /read` | Which screen + visible text (phase, powers, stardust, errors), plus `world` (the laptop's state snapshot) and `worldLastDeath` (where the partner last died) — see "The couch glance" |
| `POST /solve {power}` | Tap the power, run the whole puzzle in-page, return a transcript (problems seen, answers given, tap sequence observed, duration, retries) |
| `POST /screenshot` / `POST /shutdown` | as above |

**Honesty split:** the phone *player* owns strategy — which power, when, and why —
and critiques from the transcript. The driver owns puzzle *mechanics*, all of
them, because the puzzles are human-paced: QuickMath and Trivia give 30s for 3
items, and a free-tier LLM turn costs ~12s+ — no in-puzzle LLM round-trip can
fit even once. (That mismatch is itself a playtest data point: these puzzles are
tuned for thumbs, not tokens.) Trivia answers come from the question pool the
page itself serves (`import('/src/.../triviaLogic.ts')` via the Vite dev
server — still zero-diff); QuickMath is computed; TapSequence is observed from
the demo flashes and repeated. The report must label driver-mechanics as such.

**The couch glance (`/read` → `world`).** `/read` returns, alongside the phone
screen, the laptop driver's own `/state` snapshot — position, `respawnCount`,
`enemyFrozen`, `platformCount`, `darkZonePresent`, `lastCastPower` — and
`worldLastDeath`, the laptop driver's last captured `diedAt`. The phone driver
fetches both from the laptop driver's command port, whose `harnessDir` it
verifies first, so a glance can only ever read this checkout's game.

`worldLastDeath` carries the laptop's whole last-death record, so it gained
`lastStoodAt` with `/move` — the phone seat asking "did they fall off the bridge
or never reach it" is the same question from the other side of the couch — and
it gained the death sampler's records with it. The glance can now answer for a
fall the partner's own reply never mentioned, which is the one thing a
co-located human sees that the partner does not.

`worldLastDeath` is not decoration: the complaint this feature answers is
specifically "I could not tell whether my partner died to the sentry, the pit,
or something else", and a live snapshot cannot answer it — after a death,
`world.x`/`world.y` is the **respawn point**, the exact artefact `diedAt` exists
to defeat. The two travel as separate fields so neither seat can mistake one for
the other, and the phone prompt carries the same warning the laptop prompt does.
A human on the couch watches the death happen, so carrying it is the more
faithful glance, not a more generous one.

Why the harness owes the phone seat this: the premise is two people on one
couch, and a co-located human looks up and sees the platformer. Headless drivers
deny that, and the seats noticed — three phone seats across three pilots
volunteered the same complaint, that they could not tell whether their partner
died to the sentry, the pit, or something else, and that supporting blind felt
bad. That specific blindness was the harness's, not the game's.

Two limits keep it honest. It is **not** an in-game feedback channel: the phone
UI shows none of this, so "the game should tell the phone player more" remains a
live finding for anyone playing in separate rooms, and a report may never credit
the game for what a glance supplied — label it like any other driver affordance.
And it rides on `/read` only, never on `/solve`, which returns the instant a cast
lands because the laptop needs every millisecond of a ~3s freeze; a glance costs
the seat a deliberate look away from the phone, which is what it costs a human.
It fails soft: an unreachable or not-yet-booted laptop driver returns
`world: null` with a `worldNote`, bounded at 2s, and never fails the `/read`.

## Rate-limit strategy

- Free-tier quotas are per model AND per **day**, and smaller than the per-minute
  folklore suggests: the first pilot attempt died instantly because
  `gemini-3.6-flash` free tier is **20 requests/day**
  (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) and the day's budget was
  already spent. pi exits on such a 429, so a spent model is a dead-on-arrival
  session — `run-pilot.sh` now preflights one cheap request per player model and
  aborts with a clear message instead.
- Google's per-**minute** throttles (15 rpm on the lite tiers) were ALSO fatal:
  their text says "quota exceeded", which pi's retry classifier treated as
  terminal account exhaustion, killing both players mid-run on the first hot
  exchange. Two upstream fixes, both on pi's shipped defaults — the harness
  needs no settings override: `packages/ai/src/utils/retry.ts` treats a
  per-minute request-rate quotaId as retryable (per-day and token-rate stay
  fail-fast), and `_prepareRetry` floors its backoff at the delay Google states
  in the same body (`RetryInfo` / "Please retry in 25.3s"), because the default
  2s/4s/8s ladder spends its whole budget at t=14s — entirely inside a 25s
  throttle window, where no attempt can succeed.
- Default seats: laptop `google/gemini-3.5-flash-lite` (the judgment seat),
  phone `google/gemini-3.1-flash-lite`. Override via `LAPTOP_MODEL`/
  `PHONE_MODEL`. Ruled out: the 2.5-era models (404 for new users) and the
  gemma tier — gemma tool-calls fine but its free tier caps input at
  16k tokens/min, which a pi session's context alone exceeds, so it 429-dies on
  the first real turn (the preflight passes only because its probe is tiny).
- `intercom_wait` blocks token-free — the prompts lean on it hard ("wait for your
  partner, don't poll").
- Drivers do all busy-waiting internally; a blocked HTTP call costs no tokens.

## Orchestration (`run-pilot.sh`)

1. Preflight: constellation `npm run dev` up (start + wait on :5180 and
   :3081/healthz if not), `npm install` in `.pi/playtest/` if needed.
2. Mint `RUNID`; channel = `playtest-<RUNID>` (fresh channel per run — no stale
   backlog, no clear step); `VIDEO_DIR=reports/video/<RUNID>`.
3. Start both drivers in the background; wait for their `/health`.
4. Render the two prompt templates (`prompts/laptop.md`, `prompts/phone.md`) with
   RUNID/channel/ports; launch both sessions in parallel:
   `./pi-test.sh -p -nc --model <model> -n playtest-<role>-<RUNID> "<prompt>"`.
   (`-nc`: the pi repo's AGENTS.md is about developing pi — noise for a player.)
5. Babysit with a hard timeout (default 25 min); kill + report on overrun.
6. Collect `reports/<RUNID>-laptop.md` + `reports/<RUNID>-phone.md`.

Ports are single-sourced. `LAPTOP_DRIVER_PORT`/`PHONE_DRIVER_PORT` are read by
the orchestrator, exported to the drivers, and substituted into the rendered
prompts. `GAME_PORT` reaches the drivers as the `GAME_URL`/`PHONE_URL` the
orchestrator derives from it and exports — the drivers navigate by URL, so
exporting the bare port would health-check one server while Chromium opened
another. So one override moves every side.

### Port isolation (why the defaults are derived, not fixed)

Pilot 3's second run was voided by this harness, not by the game.
`~/Projects/party-line` holds a **copy** of it, a session there started a run
while ours was mid-play, and both copies defaulted to the fixed ports
4801/4802. `run-pilot.sh` shuts down whatever answers those ports before
starting its own drivers (step 4), so each run killed the other's drivers and
then drove the survivor's game: our seat read `lastCastPower` from casts our
phone never made, our screenshots landed in the other checkout's `reports/`,
and both runs produced plausible-looking, worthless results.

Two changes, because either alone leaves a hole:

- **Derived defaults** (`driver/ports.mjs`) — `HARNESS_DIR` (realpath'd, so a
  symlinked checkout hashes to the same slot as itself) hashes to a port pair in
  41000-44999, above where dev servers cluster and below macOS's ephemeral
  range, on a stride of 2 so one checkout's laptop port can never be another's
  phone port. Both drivers, `run-pilot.sh` and `verify-rails.sh` read their
  defaults from that one module, so no side recomputes the derivation. Two
  checkouts now cannot find each other at all.
- **Ownership checks on both sides of the port** — `/health` reports
  `harnessDir`, and nothing in the harness kills *or drives* a driver that
  answers with a different one. `stop_drivers` refuses the shutdown and prints
  what it refused; `run-pilot.sh`'s post-spawn health gate requires a matching
  `harnessDir` rather than any HTTP 200, and aborts the run otherwise;
  `verify-rails.sh` asserts the same before its first command; the phone's world
  glance verifies it before it will return a `world`. Refusing to kill a foreign
  driver is not the same as refusing to play through one — our own driver dies
  on bind (`EADDRINUSE`, into a log nobody reads) and the foreign one would then
  satisfy a bare health check for it, so both halves are needed. Together they
  cover what the derivation can't: an explicit `LAPTOP_DRIVER_PORT=` override
  that collides, or the ~1/2000 hash collision between two checkouts. A port
  that answers nothing, or answers without a `harnessDir`, is left alone — the
  pid files still reap the drivers this run started.

`LAPTOP_DRIVER_PORT`/`PHONE_DRIVER_PORT` still win when set, and still move
every side together.

Everything the script backgrounds gets its own process group (`set -m`), and
teardown kills the group — `npm run dev` is a wrapper around vite and the relay,
and each player pid is a subshell with pi inside it, so a plain `kill` reaches
neither. Driver cleanup runs from an `EXIT`/`INT`/`TERM` trap armed as soon as
the drivers are up, so the preflight's own `exit 1` on a spent daily quota — the
expected bail-out — cleans up too. `./run-pilot.sh teardown` additionally reaps
:5180/:3081 by port, but only when `logs/dev.pid` records that this script
started the server; a dev server you started by hand is left alone.

### Watching a run

- `HEADED=1 ./run-pilot.sh` launches real Chromium windows (game 960×600, phone
  390×720) instead of headless ones — nothing else changes, including what the
  players can perceive.
- Every run records video to `reports/video/<RUNID>/{laptop,phone}.webm`
  regardless of `HEADED`. Playwright only finalizes those files when the context
  closes, so they appear at `/shutdown` — i.e. when the run ends. That flush
  happens before the driver answers, so the orchestrator gives `/shutdown` a
  `SHUTDOWN_TIMEOUT_S` (90s) budget rather than a ping-sized one, and prints the
  path each driver reports saving instead of asserting the directory has files.
- A laptop `/boot` that fails adds a third file to that directory,
  `laptop-boot-failed.webm`, so a boot that never reached the game is still
  watchable. Repeated failed boots overwrite it — it holds the latest failure.
  There is no phone equivalent, because the two drivers guard different spans:
  the laptop's `try` wraps the whole boot, while the phone's wraps only
  browser/context/page creation, which by construction has no recording yet. A
  `/join` that fails after that (a bad `PHONE_URL` throws; a relay that never
  answers returns HTTP 200 with a `note`) leaves its page live either way, so
  the footage is not lost: it lands in the ordinary `phone.webm` at `/shutdown`.
  Watch that file, not a missing one.

The claude session that ran the pilot synthesizes the two player reports into the
final critique for Kyle; players only report their own seat's experience.

## Player contract (in both prompts)

- You are a playtester, not a QA bot: notice fun, friction, confusion, pacing,
  and how co-op *feels* — the report is the deliverable, the clear is just the
  vehicle. Log observations into your notes file as you go.
- Coordinate over intercom channel `playtest-<RUNID>` (short messages, alias =
  your role); `intercom_wait` when it's not your move.
- Drive only through your driver's endpoints; don't read constellation source
  (spoilers — a playtester doesn't get the code) and write only your own
  notes/report files.
- Report format: What happened (timeline) · What worked · What frustrated ·
  What confused · Co-op feel (communication load, whose fault failures felt
  like) · Bugs/suspect behavior · One change you'd make first.

## Verification plan

1. **Rails first, no LLM** — DONE (2026-08-11): `verify-rails.sh` drives a full
   two-client planet-1 clear through both drivers (boot → ws-sniffed room code →
   join → all three puzzle executors solving for real → `won:true`,
   `completed['planet-1']:true`, planet-2 unlocked). Lessons folded back into
   the drivers and prompts: `/solve` returns the instant the cast lands (a 1.2s
   feedback wait ate a third of the freeze window), `/move` grew `jumpAtX`
   (fixed-cadence hops kept landing 10px short of the far ledge), and parking
   mid-level between turns is lethal (sentry patrol), which the laptop prompt
   now teaches as technique without leaking the level layout.
2. **Then the pilot:** run `run-pilot.sh`, two live sessions, one planet.
3. **Scripted measurement, when a pilot leaves a question open** — DONE
   (2026-08-13): `aim-sweep.sh` sweeps one `/move` parameter across many trials
   and records each outcome, for questions a pilot cannot answer because a
   free-tier seat dies long before the sample size arrives. Same rules as
   `verify-rails.sh`: it drives the real drivers, it is not a seat, and player
   prompts must never reference it. Two techniques it added are reusable —
   `/planet` as a per-trial reset (`scene.start`, so no state leaks between
   trials) and a live trajectory trace, which works only because `/state` is
   registered off the laptop driver's serial command chain and so answers while
   a `/move` is still running. See `AIM-SWEEP-2026-08-13.md`.
4. Keep `reports/` + driver logs as run artifacts (git-ignored except the pilot
   report Kyle gets).

## Known limits (accepted for v1)

- Headless = no pixels for the players; they critique via state, driver
  observations, and screenshots they can't see (screenshots are for Kyle's
  report). A vision pass is a v2 idea, not free-tier-viable today. The couch
  glance gives the phone seat the same state numbers the laptop seat reads — it
  restores what a co-located human would see of the *world*, not pixels, and
  neither seat sees the game's art, animation, or feel.
- PhaseAlign (`planet-3`) auto-solve is out of scope for the pilot.
- One run, one planet; no persistence reset semantics beyond what the run needs.
- Drivers trust localhost — no auth on the command ports; same trust boundary as
  the dev server itself.
