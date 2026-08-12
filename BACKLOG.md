# Fork Backlog (ksdisch/pi)

Fork-only work items. Upstream issues live in earendil-works/pi; Constellation
playtest work is tracked in `.pi/playtest/` and owned by its own sessions.
Groomed by `/backlog-hygiene`; see `docs/backlog-hygiene/` for decision briefs.

## Active (sequenced)

1. **Context-fullness watcher + auto-proposed handoff** — on `agent_settled`,
   check `ctx.getContextUsage()`; past a threshold, propose (or via a setting,
   auto-run) the handoff note write and offer the existing successor spawn
   (`.pi/extensions/handoff/index.ts:226`). First wedge of the
   autonomous-sessions north star. Source: handoff DESIGN.md v2 hooks.
   *Picked 2026-08-11 — see docs/backlog-hygiene/2026-08-11.md.*
2. **Autonomous successor spawning (remaining slices)** — spawn without a
   human confirm, including non-TUI modes (print/RPC). The `kickoff` note
   field (`notes.ts:38`, `digest.ts:246`) is the contract. Depends on item 1
   for stopping-point detection.
3. **Slack/Telegram loop-in at decision points** — value materializes once
   sessions run unattended; sequence after item 2. Needs a design pass and
   external credentials.
4. **Repo-scoped event ledger** — underspecified; needs design-first. Seed is
   the dated `.pi/handoffs/` history.
5. **Walk-up note detection / cross-cwd routing** — small; no observed pain
   yet (all fork work happens at repo root).

## Parked / Retired

(nothing yet)
