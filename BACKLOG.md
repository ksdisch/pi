# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi; Constellation
playtest work is tracked in `.pi/playtest/` and owned by its own sessions.
Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/` for decision briefs.

## Active (sequenced)

1. **Slack/Telegram loop-in at decision points** — its value was gated on
   sessions running unattended, which the shipped item below now delivers, so
   this is next rather than speculative. Needs a design pass and external
   credentials.
2. **Repo-scoped event ledger** — underspecified; needs design-first. Seed is
   the dated `.pi/handoffs/` history.
3. **Walk-up note detection / cross-cwd routing** — small; no observed pain
   yet (all fork work happens at repo root).

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
