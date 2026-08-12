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
 pi session "laptop"  ── bash/curl ──▶  laptop driver :4801 ──▶ Chromium: game ?test=1
        │ intercom (file channel, token-free waits)                    │ ws :3081
 pi session "phone"   ── bash/curl ──▶  phone driver  :4802 ──▶ Chromium: phone.html
```

**One persistent Playwright driver process per view**, each owning a long-lived
headless Chromium page and speaking a tiny JSON-over-HTTP command surface on
localhost. The LLM never does frame-level control: **one agent turn = one batched
command** (a whole maneuver, a whole puzzle read), because free-tier Gemini gives
~5 requests/min/model and every LLM turn is precious. All polling, timing, and
retries live inside the driver, where they're free.

Room code discovery needs no game change: the driver hooks the game page's
websocket (`page.on('websocket')`) and reads the `room-created` frame.

### Laptop driver (`driver/laptop.mjs`, port 4801)

| Command | Does |
|---|---|
| `POST /boot` | Launch browser → `?test=1` (co-op, no solo) → wait for Lobby → return `{roomCode}` |
| `POST /await-phone` | Block until the `phone-joined` frame (Hub starts) |
| `POST /planet {id}` | `startPlanet(id)` via bridge, wait for `sceneKey==='Planet'`, return state |
| `POST /state` | Compact `getState()` snapshot |
| `POST /move {...}` | One maneuver: timed left/right, cadence `hop`, one-shot `jumpAtX` (jump at a gap's lip), optional `untilX`, hard `maxMs`; runs as a single in-page loop; returns before/after x/y, respawn delta, `won`, sfx events. Optional `arm` pre-commits the maneuver on a partner's cast (see "Armed moves" below) |
| `POST /screenshot` | PNG into `reports/shots/` |
| `POST /shutdown` | Close browser, exit |

**Honesty rule, enforced by tooling:** the laptop driver exposes **no cast
command**. In co-op mode every cast must come from the phone solving a real
puzzle, exactly like a human pair. (The bridge's `cast()` would silently bypass
the partner — that's a solo-verification affordance, not a co-op one.)

**Armed moves — the one latency affordance.** `/move` takes an optional
`arm: {on: "freeze"|"platform", timeoutMs}` (`timeoutMs` only tightens the 90s
ceiling, mirroring `maxMs` — a hold that outlived the caller's curl deadline
would wedge the seat's serial command chain): the astronaut stands still until
the trigger fires (`enemyFrozen` on; `platformCount` rising above the lowest
count seen since arming — the game caps live platforms at one, so a fixed
arm-time baseline could never fire after a re-arm), waits a fixed ~200ms
human-reaction pause, then runs the pre-committed move. Why it exists: both pilots died on the cue-to-cast round trip — the run-2
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

### Phone driver (`driver/phone.mjs`, port 4802)

| Command | Does |
|---|---|
| `POST /join {code}` | Open phone.html, enter code, return spellbook summary |
| `POST /read` | Which screen + visible text (phase, powers, stardust, errors) |
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
3. Keep `reports/` + driver logs as run artifacts (git-ignored except the pilot
   report Kyle gets).

## Known limits (accepted for v1)

- Headless = no pixels for the players; they critique via state, driver
  observations, and screenshots they can't see (screenshots are for Kyle's
  report). A vision pass is a v2 idea, not free-tier-viable today.
- PhaseAlign (`planet-3`) auto-solve is out of scope for the pilot.
- One run, one planet; no persistence reset semantics beyond what the run needs.
- Drivers trust localhost — no auth on the command ports; same trust boundary as
  the dev server itself.
