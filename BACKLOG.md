# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi; Constellation
playtest work is tracked in `.pi/playtest/` and owned by its own sessions.
Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/` for decision briefs.

## Active (sequenced)

1. **Autonomous successor spawning** — spawn without a human confirm, including
   non-TUI modes (print/RPC). The `kickoff` note field (`notes.ts:38`,
   `digest.ts:246`) is the contract. Stopping-point detection now exists
   (`watcher.ts`), but `newSession()` is only on `ExtensionCommandContext`, so
   an event handler cannot spawn — closing that likely needs an upstream change,
   not a fork-local one. Start there.
2. **Slack/Telegram loop-in at decision points** — value materializes once
   sessions run unattended; sequence after item 1. Needs a design pass and
   external credentials.
3. **Repo-scoped event ledger** — underspecified; needs design-first. Seed is
   the dated `.pi/handoffs/` history.
4. **Walk-up note detection / cross-cwd routing** — small; no observed pain
   yet (all fork work happens at repo root).

## Shipped

- **Context-fullness watcher + auto-proposed handoff** (2026-08-11, PR #14) —
  `agent_settled` reads `ctx.getContextUsage()` and, past a configurable
  threshold, proposes or auto-writes a mid-session handoff note; the successor
  spawn is offered by teeing up `/handoff`. See the watcher section in
  `.pi/extensions/handoff/DESIGN.md` and
  `docs/build-plans/2026-08-11-context-fullness-watcher.md`.

## Parked / Retired

(nothing yet)
