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
4. **Playtest driver `diedAt` capture** — capture x/y at the moment
   `respawnCount` increments and return it as `diedAt`, leaving `state` as
   post-respawn truth. Pilot 3's highest-value recommendation: the
   misattribution distorted reasoning in all three pilots. Picked 2026-08-13
   (Arc A, in flight). See `.pi/playtest/PILOT-2026-08-12.md`.
5. **Playtest driver port isolation** — derive default ports from the harness
   path instead of hardcoded 4801/4802; `stop_drivers` refuses drivers whose
   `/health` reports a different `HARNESS_DIR`. Two checkouts silently
   corrupted each other in pilot 3 run 2. Picked 2026-08-13 (Arc A, in
   flight).
6. **Phone-seat visibility (driver-side only)** — three phone seats across
   three pilots reported being blind to world state; partly game-side, scope
   carefully. Stretch item on Arc A.
7. **Token-rate 429 retryability** — a 429 carrying an explicit `RetryInfo`
   killed a seat mid-run (pilot 3, finding 6); candidate change to
   `packages/ai/src/utils/retry.ts`. Grows the rebase-sensitive surface;
   consider upstreaming instead.
8. **Post the `newSession()` Contribution Proposal upstream** — Kyle-action
   (~5 min): draft ready in `docs/upstream/newsession-on-extension-context.md`,
   branch `feat/expose-newsession-to-events` pushed, not yet posted.

## Shipped

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
