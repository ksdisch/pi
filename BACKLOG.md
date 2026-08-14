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
4. **Jump-outcome telemetry on `/move`** — the aim sweep's two follow-ups, and
   the first is a correctness bug, not a nicety: `/move` reports `jumped` when
   the driver *pressed* jump, so a request the astronaut could not act on (it
   was already airborne past the fall edge) is indistinguishable from a real
   jump. Eight sweep trials at `jumpAtX` ≥ 646 reported `jumped` having never
   left the ground, and pilot 4 burned a finding on the same ambiguity from the
   seat's side. Second, `/move` should separate "fell off the bridge" from "fell
   into the pit" — 19 sweep trials were correctly-aimed jumps that landed and
   then walked off, and every one of them reported as a plain pit death. Same
   shape as `diedAt` in PR #21: the harness knows and discards it. See
   `.pi/playtest/AIM-SWEEP-2026-08-13.md`.
5. **Playtest harness review follow-ups** — five nice-to-haves, none blocking.
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
6. **Report a trigger's remaining life alongside `arm-fired`** — pilot 4
   finding 5. Both `/move` arm triggers fire on the *level*, so an arm placed
   against an already-running 3s freeze fires in 61ms and reads to the seat as
   "the window is open" when it is closing; two run-B deaths followed within
   0.65s of the thaw. Carrying e.g. `freezeMsLeft` lets a seat tell a fresh cast
   from a lapsing one. Observability, not assistance — a human watching the
   screen already sees it.
7. **Token-rate 429 retryability** — a 429 carrying an explicit `RetryInfo`
   killed a seat mid-run (pilot 3, finding 6; both pilot-4 runs died the same
   way, at ~3.5 and ~5.5 min); candidate change to
   `packages/ai/src/utils/retry.ts`. Grows the rebase-sensitive surface;
   consider upstreaming instead.
8. **Post the `newSession()` Contribution Proposal upstream** — Kyle-action
   (~5 min): draft ready in `docs/upstream/newsession-on-extension-context.md`,
   branch `feat/expose-newsession-to-events` pushed, not yet posted.

## Shipped

- **Planet-1 aim sweep** (2026-08-13) — the experiment pilot 4 owed, run as a
  scripted 68-trial probe (`aim-sweep.sh`) rather than another two-seat pilot,
  because a free-tier seat dies inside 5.5 minutes and this needed ~70 attempts.
  Answer: **no level change is indicated.** No bare `jumpAtX` cleared the pit at
  any of 12 values (0 of 48), including 19 attempts that landed on the bridge and
  then ran off it; `jumpAtX` with an `untilX` over the bridge landed 6 for 6
  across a 72px span of take-off points. The wall is feedback, not difficulty —
  which is what Active items 4 and 6 now carry. See
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
