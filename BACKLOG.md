# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi. Playtest
*harness* items are tracked here as of 2026-08-13 (previously owned by their
own sessions); game-side Constellation findings still route to the
constellation repo. Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/`
for decision briefs.

## Active (sequenced)

1. **Teach the seat where the lip IS, not just to jump** — pilot 9 finding 2,
   the successor to the composition item the trigger-bound rule half-closed.
   The rule converted run A completely (9 `jumpAtX` calls in 14 moves, 4
   take-offs from 4 presses, a clear) and did not convert run B, which issued
   one composed move in 62 and aimed it 64–72px PAST the lip its own records
   supported at that moment (`lastStoodAt` 648–656 across rc=4/7/9/10/11) — so
   the residual failure is no longer "never retrieves the option" but "retrieves
   it and mis-parameterises it". Two concrete pieces: PR #37 review F11 (the
   sampler-scope check reads "sits near where this fall started", which is
   circular — the drafted replacement is "within ~150px of `diedAt.x` on the
   side you came from"), and a check on the aim itself, since a `jumpAtX` past
   the most recent fall's `lastStoodAt` is refusable before it is sent. Prompt
   work; next pilot's headline change.
2. **A seat killed by the ceiling never writes its report** — pilot 7 finding 6,
   now the binding constraint rather than a footnote. Surviving 429s (PR #30)
   means a seat no longer dies of rate limits: pilot 9 run B lived 34m46s and
   358 records and was still playing when `PILOT_TIMEOUT_S` killed it, so
   neither of its seats wrote a report and the pilot's critique deliverable was
   half of pilot 8's. Ten seats across nine pilots, none has ever written one on
   a 429 or ceiling ending. Candidate: the orchestrator warns the seats over
   intercom at T-minus-N and only then hard-kills, or SIGTERMs with a grace
   window the prompt teaches as "write now". Notes files do survive, so this
   buys the report, not the observations.
3. **The driver ledger cannot see a sampler death nothing drained** — pilot 9
   finding 7. Sampler coverage is only measurable over the deaths some `/state`
   drained: run B's last 32 deaths are unmeasurable because the seat stopped
   looking and the run was then killed. Pilot 8's coverage table has the same
   conditioning and never showed it. Candidate: drain the sampler at
   `/shutdown` (or log the queue depth there) so a run's coverage figure covers
   the whole run instead of its drained prefix. Small; makes every future
   sampler number honest without a caveat paragraph.
4. **Slack/Telegram loop-in at decision points** — design pass ran 2026-08-15
   (`docs/build-plans/2026-08-15-slack-loop-in.md`, PR #35): bridge the
   intercom's `kyle` channel to Telegram v1, Slack as a later port. Remaining:
   Telegram credentials (Kyle-action, named in the doc), then the build.
5. **Repo-scoped event ledger** — underspecified; needs design-first. Seed is
   the dated `.pi/handoffs/` history.
6. **Walk-up note detection / cross-cwd routing** — small; no observed pain
   yet (all fork work happens at repo root).
7. **Playtest harness review follow-ups** — nice-to-haves, none blocking.
   Three from PR #21's adversarial review: mid-boot `/state` should guard on
   `booted` rather than `page` so a glance reports "laptop not ready" instead
   of a raw TypeError (F5 — the raw-TypeError half has since softened to a
   descriptive throw, but the mid-boot window where `page` exists before
   `booted` flips remains); the derived port range's rationale holds on macOS
   but sits inside Linux's default ephemeral range (F6); the
   glance's documented 2s bound is ~4s on the first `/read` (F10). (F9, the
   `lastDeath` freshness inversion across a `/planet` re-entry, shipped with
   pilot 8's death sampler — the sampler's monotonic ordering made clearing the
   record a correctness requirement rather than a nicety.) Plus one from
   pilot 4's appendix: tee `verify-rails.sh` to `logs/<date>-rails.log`, since
   it prints its figures to stdout and `rm`s its temp file, leaving the "Rails
   first" numbers as the one claim in that report a reader cannot check.
   `aim-sweep.sh` already tees; this is copying that across.
   Grown 2026-08-15 with the still-open leftovers of two later reviews. From
   PR #31's (pilot 8; F3/F4/F12/F13/F14 fixed in PR #33, F6/F11 ride the
   pilot 9 arc): the sampler's between-planets guard comment is load-bearing
   and wrong (F5); `/state` now mutates but `common.mjs`'s off-chain contract
   still says pure reads only (F7); the aim-margin "subtract 20px" line is
   rightward-only and inverts for `dir: "left"` (F8); the post-loop jump
   resolver can emit `jump-ignored` on a move whose death it saw but never
   reported (F10). From PR #32's (red CI fix): the intercom workflow's "tests
   import pi types only" comment is now false (F1); the vitest alias
   prefix-matches, so a future pi-tui subpath import dies at runtime (F3);
   the handoff extension's sibling config carries the identical trap behind a
   comment that reads as a guarantee (F4).
   From PR #37's (pilot 9; F1/F2/F3/F4 fixed in that PR): the crossing rule has
   no platform carve-out, stated absolutely and keyed to a location rather than
   to `platformCount` (F5 — judge upheld nice-to-have and showed the obvious
   carve-out would be WRONG, since a summoned platform is raised rather than
   flush, so read the ruling before acting on it); `-ne -e <intercom>` subtracts
   five discovered extensions while the `run-pilot.sh` comment and DESIGN both
   say one (F6); the `RECENT_DEATHS_MAX` docblock's "drained on `/state`" claim
   (F7, text already gone, finding recorded); `/state` returns the live
   `recentDeaths` array by reference beside a separately captured `lastDeath`,
   a narrow within-reply race a `.slice()` closes (F8); the `/state` route
   comment still asserts the invariant DESIGN retracted in the same commit (F9);
   the `state handed rc=[…]` reach line counts phone glances, which discard
   `recentDeaths`, with no caller marker (F10). F11 rides Active item 1.
8. **Report a trigger's remaining life alongside `arm-fired`** — pilot 4
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
9. **Post the `newSession()` Contribution Proposal upstream** — Kyle-action
   (~5 min): draft ready in `docs/upstream/newsession-on-extension-context.md`,
   branch `feat/expose-newsession-to-events` pushed, not yet posted. PR #32
   review F2 — the Cloudflare compat test's pin to a volatile,
   network-hydrated catalog model id — is a second upstream-post candidate to
   carry along.

## Shipped

- **Co-op pilot 9 — composition, half converted** (2026-08-15, PR #37) — the
  composition experiment, and with it the former Active items "expose more than
  the newest death on `/state`" and "stop handoff-digest injection into playtest
  seats". **Run A cleared planet-1** (`won: true` at x=892, rc 8, 7m23s) — the
  second clear in nine pilots — and it is the seat role that issued **zero**
  `jumpAtX` in both pilot 7 and pilot 8 (zero in 60 calls in pilot 8 run A
  alone): with the trigger-bound crossing rule it issued **9 in 14 moves and
  took off on 4 of 4 presses**, aiming `jumpAtX: 624` off a lip of 644 that a
  *sampler-only* death supplied, then clearing from the bridge at
  `jumpAtX: 816`. Run B did not convert — 1 composed move in 62, aimed 64–72px
  PAST the lip its records supported, refused (`jump-ignored`, pressed at y=514
  already falling) — so the
  rate is still 1 of 2 and the residual failure changed shape from "never
  retrieves the option" to "mis-parameterises it" (new Active item 1).
  `recentDeaths` measured clean: **7 of 7 sampler-only deaths reached a seat**
  against pilot 8's 3 of 12, with a ledger line showing a non-newest death
  (`rc=15 kept=false listed=true`) delivered where one slot dropped it. The
  sampler placed **25 of 25** deaths in the measurable window with none seen by
  neither (pilot 8: 39/43 and 1) — small sample, and run B's 32-death tail is
  excluded because nothing drained it (new Active item 3). Digest contamination
  is **zero across all four seats**, where pilots 5–7 reproduced it in every
  one. 429s no longer end runs at all: run B's laptop survived 21 and was still
  playing when the 2100s ceiling killed it — which is why neither of its seats
  wrote a report (new Active item 2). The adversarial review paid for itself
  twice: it caught that the shipped 5-slot cap evicted records *inside the drain
  that added them* (the cap is now 10, the deepest drain pilot 8's ledger
  contains) and that the `listed=` flag would have over-reported the very reach
  number this pilot publishes. See `.pi/playtest/PILOT-2026-08-15-run9.md`.
- **Co-op pilot 8 — the planet fell** (2026-08-14) — the aim-margin experiment,
  and with it the former Active item "capture deaths that complete between
  moves". **Run B cleared planet-1** (`won: true` at x=892, rc 7, 7m46s), the
  first live co-op clear in eight pilots; run A played 19m17s for 36 deaths and
  no clear. The two changes composed into one chain: run B walked into the pit
  on a move that returned `reached-x` and reported no death at all, the new
  death sampler placed that fall (`lastDeath {756, 578, lastStoodAt: {652, 476},
  via: "sampler"}`), the seat read 652 as the near lip, and the taught 20px
  margin turned that into `jumpAtX: 630` — presses at 632 and 636, **three
  take-offs from three presses**, against pilot 7's one from five at
  `jumpAtX: 645`. The clearing jump was taken from the bridge itself
  (`before {808, 429}`). Sampler coverage across both runs: 43 deaths, `/move`
  saw 30, the sampler 39, **12 seen only by the sampler**, 1 by neither; on the
  deaths both saw, the two independently-sampled `diedAt`s agree to within a
  poll, the first cross-check on `diedAt` that is not the aim sweep's trace.
  Also measured: 17 per-minute 429s survived across the two runs (13 + 4; 16 of
  them the token-rate shape, one request-rate, zero per-day), where a single one
  of that shape was what killed the four seats the 429 item records — so both
  runs ended gracefully and **all four seats wrote their reports**, closing
  pilot 7's finding 6. Run B recorded zero `arm-timeout`s. Two things did not
  move: run A never issued a single `jumpAtX` (the same one-seat-in-two
  composition rate as pilot 7), and one distance-as-progress misread survived on
  a record that *did* reach the seat — both pit lips are ground height, so
  `lastStoodAt.y` cannot separate near from far. The pilot's own driver ledger
  also caught a defect in the change: a tie-break that preferred `/move`'s copy
  unconditionally discarded the sampler's more informative one on run B's rc=7
  (bridge at `{800, 429}` vs no `lastStoodAt` at all); fixed post-run. See
  `.pi/playtest/PILOT-2026-08-14-run8.md`.
- **Token-rate 429 retryability** (2026-08-14) — closes the former Active item
  6. A `GenerateContent…InputTokensPerModelPerMinute` 429 is now retryable in
  `packages/ai/src/utils/retry.ts` (absent per-day violations or account
  markers, which stay terminal over everything). The body cannot distinguish a
  rolling window filled by earlier requests (the shape that killed four pilot
  seats fail-fast, at 39.2s/49.5s stated delays) from a request whose context
  alone exceeds the cap — the review caught that Google attaches `RetryInfo`
  even to per-day exhaustion, so a stated delay discriminates nothing — and
  every captured failure is the rolling-window case, so both retry: the wrong
  guess costs a bounded, abortable backoff where the fail-fast killed whole
  sessions. Request-rate per-minute quotas stay retryable as before; the 90s
  server-delay clamp reasoning still holds (token windows are also rolling
  60s). Tests pin the flipped captured fixture, the no-delay body,
  per-day-outranks, and mixed violations. Rebase surface unchanged: only
  files already on the fork's rebase-sensitive list were touched, and per
  that list's precedent no upstream changelog entry was added.
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
  invisible deaths carried all 3 of the pilot's misreads (the between-move-deaths item's case,
  now airtight); digest injection proved per-seat (item 10). No seat wrote
  a report in either run. See `.pi/playtest/PILOT-2026-08-14-run7.md`.
- **Co-op pilot 6** (2026-08-14) — the release experiment, run twice with
  finding 7's `lastStoodAt` teaching and F6's conditional freeze arm in the
  prompts. Half the answer landed: the misread is fixed on captured deaths
  (three fully-captured overflight deaths in run B, three correct "took off
  but never landed" readings, zero "cleared the pit" — while run A still
  misread the one death the driver never recorded, the between-move-deaths item's class), and the
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
  seats; 2 more between-move deaths went invisible (the between-move-deaths item's class); no seat
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
