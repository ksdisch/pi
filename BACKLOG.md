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
4. **Playtest harness review follow-ups** — four nice-to-haves from PR #21's
   adversarial review, none blocking: mid-boot `/state` should guard on
   `booted` rather than `page` so a glance reports "laptop not ready" instead
   of a raw TypeError (F5); the derived port range's rationale holds on macOS
   but sits inside Linux's default ephemeral range (F6); `lastDeath` survives a
   `/planet` re-entry that resets `respawnCount`, inverting the freshness rule
   the phone prompt teaches — clear it, and point the seat at `atIso` (F9); the
   glance's documented 2s bound is ~4s on the first `/read` (F10).
5. **Token-rate 429 retryability** — a 429 carrying an explicit `RetryInfo`
   killed a seat mid-run (pilot 3, finding 6); candidate change to
   `packages/ai/src/utils/retry.ts`. Grows the rebase-sensitive surface;
   consider upstreaming instead.
6. **Post the `newSession()` Contribution Proposal upstream** — Kyle-action
   (~5 min): draft ready in `docs/upstream/newsession-on-extension-context.md`,
   branch `feat/expose-newsession-to-events` pushed, not yet posted.

## Shipped

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
