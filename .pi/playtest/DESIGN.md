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
| `POST /move {...}` | One maneuver: timed left/right/hop, optional `untilX`, hard `maxMs`; runs as a single in-page loop; returns before/after x/y, respawn delta, `won`, sfx/burst events |
| `POST /screenshot` | PNG into `reports/shots/` |
| `POST /shutdown` | Close browser, exit |

**Honesty rule, enforced by tooling:** the laptop driver exposes **no cast
command**. In co-op mode every cast must come from the phone solving a real
puzzle, exactly like a human pair. (The bridge's `cast()` would silently bypass
the partner — that's a solo-verification affordance, not a co-op one.)

### Phone driver (`driver/phone.mjs`, port 4802)

| Command | Does |
|---|---|
| `POST /join {code}` | Open phone.html, enter code, return spellbook summary |
| `POST /read` | Which screen + visible text (phase, powers, stardust, errors) |
| `POST /puzzle {power}` | Tap the power, return the puzzle's content (question, choices, grid) |
| `POST /answer {value}` | Submit the LLM's answer (QuickMath number, Trivia choice); report solved/failed + cast confirmation |
| `POST /auto {power}` | Mechanical puzzles only (TapSequence now; PhaseAlign later): driver performs the taps, reports what it took (duration, attempts) |
| `POST /screenshot` / `POST /shutdown` | as above |

**Honesty split:** cognitive puzzles (math, trivia) are answered by the phone
*player* — the driver only transcribes. Reflex/timing puzzles are executed by the
driver because a 5-rpm LLM physically can't tap an 800ms window; the driver
reports the mechanics so the player can still critique them. The report must
label which was which.

## Rate-limit strategy

- Laptop player: `google/gemini-3.6-flash`. Phone player:
  `google/gemini-3.5-flash-lite` (alias fallback `gemini-flash-lite-latest`) —
  free-tier buckets are per model, so the pair never shares a 5-rpm budget.
  If lite turns out not to be free-tier-enabled, fall back to both-on-3.6-flash
  and accept slower, 429-retried turns.
- `intercom_wait` blocks token-free — the prompts lean on it hard ("wait for your
  partner, don't poll").
- Drivers do all busy-waiting internally; a blocked HTTP call costs no tokens.

## Orchestration (`run-pilot.sh`)

1. Preflight: constellation `npm run dev` up (start + wait on :5180 and
   :3081/healthz if not), `npm install` in `.pi/playtest/` if needed.
2. Start both drivers in the background; wait for their `/health`.
3. Mint `RUNID`; channel = `playtest-<RUNID>` (fresh channel per run — no stale
   backlog, no clear step).
4. Render the two prompt templates (`prompts/laptop.md`, `prompts/phone.md`) with
   RUNID/channel/ports; launch both sessions in parallel:
   `./pi-test.sh -p -nc --model <model> -n playtest-<role>-<RUNID> "<prompt>"`.
   (`-nc`: the pi repo's AGENTS.md is about developing pi — noise for a player.)
5. Babysit with a hard timeout (default 25 min); kill + report on overrun.
6. Collect `reports/<RUNID>-laptop.md` + `reports/<RUNID>-phone.md`.

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

1. **Rails first, no LLM:** drive a full two-client planet-1 clear by hand with
   curl (boot → code → join → planet → freeze/platform/illuminate via real
   puzzle solves → `won:true`). Proves drivers + pairing + honesty rules.
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
