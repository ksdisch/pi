# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi; Constellation
playtest work is tracked in `.pi/playtest/` and owned by its own sessions.
Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/` for decision briefs.

## Active (sequenced)

1. **Autonomous successor spawning + session retirement** — spawn without a
   human confirm, including non-TUI modes (print/RPC), and let a session whose
   handoff was consumed shut itself down (window closes via the exec-launch
   convention). The `kickoff` note field (`notes.ts:38`, `digest.ts:246`) is the
   contract. Design approved 2026-08-12: see the "Session lifecycle" section of
   `.pi/extensions/handoff/DESIGN.md` and
   `docs/build-plans/2026-08-12-session-lifecycle.md`. The `newSession()` gap
   turned out to be exposure-only — fork patch + parallel upstream PR, not
   upstream-first as this item previously guessed.
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
