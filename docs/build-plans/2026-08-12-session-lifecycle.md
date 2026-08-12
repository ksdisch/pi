# Plan — Session lifecycle: autonomous succession + retirement (BACKLOG item 1, widened)

Date: 2026-08-12 · Source: `.pi/extensions/handoff/DESIGN.md` § "Session lifecycle" ·
Approved by Kyle 2026-08-12 (design session; scope, spawn mechanism, window-close
convention, and spawn-note quality all picked explicitly)

## Problem

The watcher (PR #14) detects the stopping point but cannot act on it — `newSession()`
is only exposed on command contexts, so the autonomous chain dead-ends at a note on
disk. And the inverse problem clutters the desktop: a session whose work was handed
off and picked up elsewhere sits in its Warp window forever; nothing notices that it
is done.

## What gets built

Everything design-level lives in the DESIGN.md section; this plan is sequencing and
build detail. Summary:

1. **Exposure patch** — move the `newSession` graft from `createCommandContext()` to
   `createContext()` in `packages/coding-agent/src/core/extensions/runner.ts`; move
   the declaration from `ExtensionCommandContext` to `ExtensionContext` in
   `types.ts`. Only `newSession` moves. Same diff offered upstream as a PR.
2. **`PI_HANDOFF_WATCH=spawn`** — new watcher mode: compose note (mechanical
   fallback) → `ctx.newSession({ withSession })` → `sendUserMessage(kickoff)`.
   Settle-path only; `spawnPending` flag defers the before-compact crossing;
   generation cap (default 10, `PI_HANDOFF_SPAWN_MAX`).
3. **`retire.ts`** — `PI_HANDOFF_RETIRE` = `off` | `notify` (default) | `auto`.
   Predicate: own archived note stamped `consumed_by`. Lazy ~30 s poll, unref'd,
   torn down on shutdown. `auto`: 30 s grace, re-check idle/no-pending/no-activity-
   since-note, suppress the shutdown digest, `ctx.shutdown()`.
4. **exec-launch convention** — `/launch` in `~/Projects/claude-config` starts
   windows with `exec pi …`; verify Warp closes the session on root-process exit.

## Sequence (value-ordered slices)

Retirement first: it is buildable with zero patch risk and addresses the felt pain
(dead windows). The patch and spawn mode follow; the upstream PR goes out only after
the patch has been dogfooded in the fork.

1. **`retire.ts` — config + predicate + notify mode.**
   New file plus `test/retire.test.ts` (pure: env parsing, predicate against
   synthetic note frontmatter) and `test/retire-wiring.test.ts` (fake `pi`: poll
   startup gating on note-write, notify emission, teardown on `session_shutdown`).
   `notes.ts` may need a "list archived notes for session id" helper next to
   `listArchivedNotePaths`. Keep pi imports type-only. `index.ts` gains one
   `registerRetire(pi, state)` call — wiring only.
2. **Retirement `auto` mode.**
   Grace timer, re-check guards (`isIdle`, `hasPendingMessages`, last-entry-vs-note
   timestamp), digest suppression via the existing `wroteNoteThisSession`-style skip
   flag, then `ctx.shutdown()`. Wiring tests: guard downgrade to notify, digest
   suppressed on retire-initiated shutdown, activity during grace cancels.
3. **exec-launch convention (cross-repo).**
   Edit the `/launch` skill in `~/Projects/claude-config` to `exec pi …`; verify
   Warp's close-on-exit behavior once, manually, and record the result (including
   the Warp setting it depends on) in the skill. Internals-only change — no
   command-skill-reference row edit unless the skill's description changes. Fork
   side: nothing.
4. **Exposure patch.**
   `runner.ts`: move the `newSession` graft into `createContext()`. `types.ts`: move
   the `newSession` declaration into `ExtensionContext`. Update `CLAUDE.md`'s
   rebase-sensitive list (add both files). `npm run check` now applies (this is
   `packages/` code); run the coding-agent extension tests via `./test.sh`.
5. **Watcher `spawn` mode.**
   `watcher.ts`: `spawn` joins the mode enum; settle-path spawn; `spawnPending` from
   the before-compact trigger; module-level generation counter; compose-with-
   mechanical-fallback (composer callable from the event context — `modelRegistry`
   is on plain `ExtensionContext`). `withSession` submits the note's `kickoff` via
   `sendUserMessage`. Tests extend `watcher.test.ts` + `watcher-wiring.test.ts`:
   settle-only rule, cap behavior, fallback on composer error, kickoff submission.
6. **Upstream PR.**
   Same two-file diff against `earendil-works/pi` main, argued from the `shutdown()`
   precedent (`types.ts:340`) and the autonomous-continuation use case. Read
   `CONTRIBUTING.md`'s contributor gate first. If accepted, drop the fork patch at
   the next rebase and shrink the rebase-sensitive list.
7. **Dogfood + docs.**
   Live smokes (scratch dir, `-e` abs path, Gemini free tier): in-process chain at a
   low threshold; two-process retirement. Resolve the flagged unknown: does `-p`
   outlive a spawned successor's run? Then BACKLOG.md item 1 → Shipped, DESIGN.md
   status line → built.

## Blast radius

`.pi/extensions/handoff/` (retire.ts new; watcher.ts, notes.ts, index.ts touched),
two upstream files (`packages/coding-agent/src/core/extensions/{runner,types}.ts` —
`npm run check` applies), fork docs (`CLAUDE.md`, `BACKLOG.md`, DESIGN.md status),
and cross-repo the `/launch` skill in `~/Projects/claude-config`. Slices 1–3 have
zero `packages/` footprint.

## Verification gates

- `.pi/` changes: `node node_modules/vitest/dist/cli.js --run --config
  .pi/extensions/handoff/vitest.config.ts` and `npx tsgo --noEmit -p
  .pi/extensions/handoff/tsconfig.json` (`npm run check` skips `.pi/` silently).
- `packages/` changes (slice 4): `npm run check` full output plus `./test.sh`.
- Never smoke-test pi in the repo cwd — `.pi/handoffs/` holds live notes from
  concurrent sessions and the reader archives pending notes on first prompt.

## Settled — do not relitigate during the build

Env-var config over CLI flags; the watcher does not suppress the shutdown digest
(retirement does — different actor, reason stated in DESIGN.md); the reader's
liveness guard exempts our own pid; self-shutdown only, no reaper; `superseded_by`
does not satisfy the retirement predicate; osascript window closing is out of scope.

---

**Run-config note:** build this with a fresh session started from this file and the
DESIGN.md section — recommended **Opus 5, effort high** (well-specified build; the
one judgment-heavy piece, the exposure patch, is fully shaped):
`claude --model claude-opus-5 --effort high`, opening prompt "Implement
docs/build-plans/2026-08-12-session-lifecycle.md, slice by slice."
