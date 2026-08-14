# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi. Playtest
*harness* items are tracked here as of 2026-08-13 (previously owned by their
own sessions); game-side Constellation findings still route to the
constellation repo. Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/`
for decision briefs.

## Active (sequenced)

1. **Slack/Telegram loop-in at decision points** — its value was gated on
   sessions running unattended, which the shipped item below now delivers, so
   this is next rather than speculative. Needs a design pass and external
   credentials.
2. **Repo-scoped event ledger** — underspecified; needs design-first. Seed is
   the dated `.pi/handoffs/` history.
3. **Walk-up note detection / cross-cwd routing** — small; no observed pain
   yet (all fork work happens at repo root).
4. **Playtest harness review follow-ups** — five nice-to-haves, none blocking.
   Four from PR #21's adversarial review: mid-boot `/state` should guard on
   `booted` rather than `page` so a glance reports "laptop not ready" instead
   of a raw TypeError (F5); the derived port range's rationale holds on macOS
   but sits inside Linux's default ephemeral range (F6); `lastDeath` survives a
   `/planet` re-entry that resets `respawnCount`, inverting the freshness rule
   the phone prompt teaches — clear it, and point the seat at `atIso` (F9); the
   glance's documented 2s bound is ~4s on the first `/read` (F10). Plus one from
   pilot 4's appendix: tee `verify-rails.sh` to `logs/<date>-rails.log`, since
   it prints its figures to stdout and `rm`s its temp file, leaving the "Rails
   first" numbers as the one claim in that report a reader cannot check.
   `aim-sweep.sh` already tees; this is copying that across.
5. **Report a trigger's remaining life alongside `arm-fired`** — pilot 4
   finding 5. Both `/move` arm triggers fire on the *level*, so an arm placed
   against an already-running 3s freeze fires in 61ms and reads to the seat as
   "the window is open" when it is closing; two run-B deaths followed within
   0.65s of the thaw. Carrying e.g. `freezeMsLeft` lets a seat tell a fresh cast
   from a lapsing one. Observability, not assistance — a human watching the
   screen already sees it. Pilot 5 made the platform half systematic (its
   finding 4): with platforms persisting indefinitely, all five arms placed
   against an already-standing platform fired in 60–64ms with no freeze up
   across both runs, and all five died —
   after a run's first platform cast, "arm on platform" is permanently instant
   and expresses no coordination.
6. **Token-rate 429 retryability** — a 429 carrying an explicit `RetryInfo`
   killed a seat mid-run (pilot 3, finding 6; both pilot-4 runs died the same
   way, at ~3.5 and ~5.5 min); candidate change to
   `packages/ai/src/utils/retry.ts`. Grows the rebase-sensitive surface;
   consider upstreaming instead.
7. **Post the `newSession()` Contribution Proposal upstream** — Kyle-action
   (~5 min): draft ready in `docs/upstream/newsession-on-extension-context.md`,
   branch `feat/expose-newsession-to-events` pushed, not yet posted.
8. **Capture deaths that complete between moves** — pilot 5 finding 3
   (unsequenced; appended at the end pending grooming). A `/move` reply can
   only report a death inside the move, so a fall that outlives a `reached-x`
   or a freeze that lapses while parked leaves `respawnCount` advanced with no
   site recorded anywhere — 3 of run A's 11 deaths, including run A's jump
   (run B's identical jump died inside an `ms`-bounded move and was fully
   captured, so visibility currently depends on the terminator the seat
   happened to pick). The `/state` freshness guard correctly refuses to lie; the data
   is simply absent. Candidate: a light idle sampler in the laptop driver that
   keeps `lastDeath` current while no move runs — observes only, honesty split
   untouched. *Pilots 6–7 update:* 10 more invisible deaths (2 + 8), and
   every distance-as-progress misread across both pilots — including two
   "Crossed the pit!" announcements over uncaptured mid-fall deaths, one
   with a celebratory screenshot — sits on an invisible death, while all 26
   of pilot 7's captured deaths were read correctly. The sampler is what
   makes the misread checkable.
9. **Stop handoff-digest injection into playtest seats** — pilot 5, review
    finding F8 (unsequenced; appended pending grooming). The handoff extension
    injected run A's phone-session shutdown digest into run B's laptop seat at
    startup: cross-run contamination that cost the seat its first turn and
    weakens any cross-run independence claim a report makes. Decide how seat
    sessions opt out (e.g. `run-pilot.sh` launching seats with the handoff
    extension disabled or env-gated) and implement it.

## Shipped

- **Intercom wait-start boundary bug: reproduced and fixed** (2026-08-14) —
  closes the former Active item 9 (scripted repro for the delivery
  anomalies), through the fix rather than just the repro. Mechanism
  confirmed: the watcher tick claimed messages mid-run — marked seen at the
  moment of `pi.sendMessage(deliverAs: "steer")`, whose delivery cannot
  surface until the run's next LLM call — so an `intercom_wait` in the same
  run polled the shared seen-set deaf for its whole timeout (12+ live
  instances across pilots 6–7: 60–94s of deafness, manufactured
  `arm-timeout`s, out-of-order arrivals). Fix: the tick stands down while
  `agent_start` → `agent_end`/`agent_settled` is open, leaving messages
  unclaimed for any wait to return instantly; the idle-wake path is
  unchanged. Repro is `test/index.test.ts` in the extension — a fake
  ExtensionAPI + fake timers test verified to fail on the pre-fix tick and
  pass on the fix (29/29 suite green). Trade documented in the extension's
  DESIGN.md: a busy session hears a message at its next wait or at run end
  + ≤1 poll, no longer before its next LLM call. Pilot 5's separate 20.8s
  idle-seat observation is NOT closed by this (no wait was running there);
  it stays folded into future pilot observation.
- **Co-op pilot 7** (2026-08-14) — the pairing experiment, run twice with the
  `untilX` flight-semantics technique line in the laptop prompt. The pairing
  happened: run B issued `jumpAtX` + `untilX` seven times, including
  `untilX: 720`, whose cut fired mid-air exactly as a terminator should (on
  a fall — the press was refused) — and the landing still didn't: of the
  five paired moves that reached the press, four were refused
  (`jumpAtX: 645` pressed at 656 three times and 652 once) and the one
  take-off carried `untilX: 1150` and overflew (captured, read
  correctly). Run A's seat never pressed jump once — it spent 15m06s (the
  longest seat life ever) trying to walk onto the platform. Report finding 2
  proposes the aim-margin line ("set `jumpAtX` at least 20px before the
  edge") that plus the pairing should land. The intercom wait-start bug set
  the pilot's pace: ~10 new instances, 3 of run B's 4 arm-timeouts
  manufactured, 8 of run A's arms held 60–84s (item 9 — fix next). 8 more
  invisible deaths carried all 3 of the pilot's misreads (item 8's case,
  now airtight); digest injection proved per-seat (item 10). No seat wrote
  a report in either run. See `.pi/playtest/PILOT-2026-08-14-run7.md`.
- **Co-op pilot 6** (2026-08-14) — the release experiment, run twice with
  finding 7's `lastStoodAt` teaching and F6's conditional freeze arm in the
  prompts. Half the answer landed: the misread is fixed on captured deaths
  (three fully-captured overflight deaths in run B, three correct "took off
  but never landed" readings, zero "cleared the pit" — while run A still
  misread the one death the driver never recorded, item 8's class), and the
  release is still unfound — the seat varied its aim and interrogated
  platform placement across three `tookOff: true` jumps (pressed x=640–652,
  apexY 362, `diedAt` x=892–896) and never suspected the held input; run A
  issued `untilX: 800` — inside the bridge span — and 720 on walk-ins only,
  and no seat has ever paired a bridge-band `untilX` with a `jumpAtX` in six
  pilots (report finding 2 proposes the missing technique line). Run B lived
  9m05s — the longest of any pilot —
  because two 90s arm-timeouts and a 63s hold were token-free quota relief.
  Major harness catch: the intercom wait-start boundary bug (item 9's
  sharpening) manufactured one of those timeouts with both seats behaving
  correctly. The handoff-digest injection (item 10) reproduced in all four
  seats; 2 more between-move deaths went invisible (item 8's class); no seat
  wrote a report in either run. See `.pi/playtest/PILOT-2026-08-14-run6.md`.
- **Co-op pilot 5** (2026-08-13) — first live co-op with the jump-outcome
  telemetry (PR #25) in the seats' hands, and first under pilot 4 finding 4's
  arm-ordering protocol, folded into the seat prompts for this run. Both
  questions answered twice over: both laptops independently reasoned the same
  aim (x=630) from `lastStoodAt` pit data and received live take-off verdicts
  — `tookOff: true, pressedAt {632, 476}` in both runs — and both jumps
  overflew the whole bridge because nothing cut input inside the flight,
  exactly the aim sweep's release lesson reproduced from the seat side. Run
  A's overflight death was invisible (the move had returned; new Active item);
  run B's was fully captured (`diedAt {896, 602}`, `lastStoodAt {632, 476}`)
  and the seat still misread it as "Cleared the pit" (report finding 7). The
  protocol fix measured clean: 18/18 arms fired, zero `arm-timeout`s, zero
  deadlocks (pilot 4: three and two ~90s). Costs surfaced: 3 of 19 deaths
  completed between moves and are invisible to the death telemetry; five arms
  placed against an already-standing platform fired instantly and died (folded
  into the trigger-life item); and the deadlock-free pace hit the free-tier
  250k input-tokens/min
  cap sooner — 3m27s and 1m54s of play. See
  `.pi/playtest/PILOT-2026-08-13-run5.md`.
- **Jump-outcome telemetry on `/move`** (2026-08-13, PR #25) — the aim sweep's
  two follow-ups. `jumped` meant "the driver pressed jump", not "the astronaut
  left the ground", and the game grants a jump only from the ground — so a press
  made past a pit's edge did nothing while still reporting success. `/move` now
  returns `jump: {tookOff, pressedAt, apexY}` and pushes `jumped` only once an
  8px rise is observed, `jump-ignored` otherwise, `null` with no event when the
  move ended too soon to tell. A death adds `lastStoodAt`, the last spot the
  astronaut was resting on a surface, which names what it fell off rather than
  where the fall ended. Both are inferred from sampled `y` — `BridgeState`
  exposes no contact flag and the harness stays zero-diff on constellation — with
  a rest defined as two samples at the same height arrived at from above, the
  last clause being what keeps a jump's apex from reading as a ledge.
  **Measured across a full 68-trial `aim-sweep.sh` run against the shipped code**
  (log `20260813-210539`), which now records both fields per trial and scores
  them against the independent trajectory trace: **68 of 68 take-off verdicts
  agree, 0 disagree**, none unresolved. Of 59 deaths, 14 report a bridge-height
  `lastStoodAt` (429, x 828–836 off a bridge spanning 722–818) and 36 report
  ground height (476) — the "landed, then walked off the far edge" class that
  used to be indistinguishable from a plain pit death, with every bridge row
  trace-confirmed. Nine deaths report nothing: a rest needs three consecutive
  samples, and block C's stage-two moves jump on their first one. `DESIGN.md`
  carries that and the rest of the field's limits. Adversarial review ran to the
  three-round cap; its disposition is on PR #25. See `.pi/playtest/DESIGN.md`.
- **Planet-1 aim sweep** (2026-08-13) — the experiment pilot 4 owed, run as a
  scripted 68-trial probe (`aim-sweep.sh`) rather than another two-seat pilot,
  because a free-tier seat dies inside 5.5 minutes and this needed ~70 attempts.
  Answer: **no level change is indicated.** No bare `jumpAtX` cleared the pit at
  any of 12 values (0 of 48), including 19 attempts that landed on the bridge and
  then ran off it; `jumpAtX` with an `untilX` over the bridge landed 6 for 6
  across a 72px span of take-off points. The wall is feedback, not difficulty,
  and it is entirely harness-side: both follow-ups shipped as the item above, and
  nothing here routes to constellation. See
  `.pi/playtest/AIM-SWEEP-2026-08-13.md`.
- **Co-op pilot 4** (2026-08-13, PR #23) — first live co-op since constellation's
  landing-triggered platform fix (its PR #40) and PR #21's telemetry. Confirmed
  the fix in live play: platforms stood 2m54s and 3m52s unlanded-on, measured
  across repeated `/state` reads. All 15 deaths across both runs reported real
  sites, closing the misattribution arc. Both runs ended on a free-tier
  token-rate 429, not on either seat stopping. See
  `.pi/playtest/PILOT-2026-08-13.md`.
- **Trustworthy playtest telemetry** (2026-08-13, PR #21) — Arc A, all three
  items including the stretch. `diedAt` on a `/move` death reports where the
  astronaut actually was instead of where it respawned (measured: a sentry death
  at `{496, 476}` and a pit death at `{776, 600}`, both against a `state.x` of
  ~84), retiring a misattribution that distorted all three pilots. Driver ports
  derive from the harness path (`driver/ports.mjs`), `/health` reports
  `harnessDir`, and nothing kills *or drives* a driver belonging to another
  checkout — the corruption that voided pilot 3 run 2. The phone's `/read` gained
  the couch glance (`world` + `worldLastDeath`), fixing a blindness three phone
  seats reported that was the harness's, not the game's. Review also caught the
  armed `platform` trigger going dead against constellation `b7c308a` (fixed:
  level-triggered like freeze). See `.pi/playtest/DESIGN.md` and
  `.pi/playtest/PILOT-2026-08-12.md`.
- **Autonomous successor spawning + session retirement** (2026-08-12, PRs #18/#19)
  — `PI_HANDOFF_WATCH=spawn` writes the note and starts the successor itself, in
  every mode including `-p`; `PI_HANDOFF_RETIRE` lets a session whose handoff was
  consumed elsewhere notify or exit. The `newSession()` gap was exposure-only, so
  the fork carries a two-file patch moving that graft onto `ExtensionContext`
  (offered upstream separately). The window closes via the exec-launch convention
  in `claude-config`'s `/launch`. See the "Session lifecycle" section of
  `.pi/extensions/handoff/DESIGN.md` and
  `docs/build-plans/2026-08-12-session-lifecycle.md`.
- **Context-fullness watcher + auto-proposed handoff** (2026-08-11, PR #14) —
  `agent_settled` reads `ctx.getContextUsage()` and, past a configurable
  threshold, proposes or auto-writes a mid-session handoff note; the successor
  spawn is offered by teeing up `/handoff`. See the watcher section in
  `.pi/extensions/handoff/DESIGN.md` and
  `docs/build-plans/2026-08-11-context-fullness-watcher.md`.

## Parked / Retired

(nothing yet)
