# Plan — Context-fullness watcher (BACKLOG item 1, Arc A)

Date: 2026-08-11 · Source: `.pi/extensions/handoff/DESIGN.md` v2 hooks ·
Pick rationale: `docs/backlog-hygiene/2026-08-11.md`

## Problem

A session that fills its context window has already passed the point where a
handoff should have been written. Today nothing notices: the only automatic note
is the shutdown digest, which fires at quit — after compaction has already
thrown away the history the note would have summarized. `/handoff` is reliable
but requires the user to remember.

## What gets built

A watcher on `agent_settled` that reads `ctx.getContextUsage()` and, past a
threshold, writes a handoff note (or proposes writing one).

### API constraint found during design

`ctx.newSession()` lives on `ExtensionCommandContext`, not the plain
`ExtensionContext` that event handlers get (`packages/coding-agent/src/core/
extensions/runner.ts` `createContext` vs `createCommandContext`). So the watcher
**cannot** spawn a successor itself. It offers the spawn by teeing up
`/handoff` — which already composes a rich note and confirms the spawn — in the
TUI editor. Removing that constraint is backlog item 2's problem.

### Modes (env-configured)

| `PI_HANDOFF_WATCH` | Behavior at threshold |
|---|---|
| `off` | nothing |
| `notify` | report the crossing, write nothing |
| `propose` (default) | TUI: 3-way select (write note / compose via `/handoff` / not now). No TUI: degrades to `auto` — a proposal nobody can answer loses the note |
| `auto` | write the note, report the path |

`PI_HANDOFF_WATCH_AT` sets the percent threshold (default 80). Bad values fall
back to the default and warn once — never silently.

Env rather than CLI flags: a successor spawned as a child process inherits env,
which is where this is headed (backlog item 2).

### Firing discipline

- Fires at most once per crossing. Re-arms only after usage drops 10 points
  below the threshold — i.e. after a compaction, not on 79/81 flapping.
- Skips when `getContextUsage()` returns undefined or `percent: null` (unknown
  right after compaction until the next assistant response).
- Skips when `/handoff` already wrote a note this session — same reasoning the
  shutdown digest uses: a mechanical note must not supersede a richer one.
- Does **not** set `wroteNoteThisSession`. The shutdown digest still runs at
  quit, and its note is newer; the reader supersedes the watcher's.
- Skips `--no-session` runs (no session file to point at).

### Note content

Reuses `buildDigestNote` with a `trigger: "watch"` variant: `source: "watch"` in
frontmatter and a Context section that says the session was still running,
rather than the shutdown wording, which would be a lie mid-session.

## Sequence

1. `notes.ts`: `HandoffSource` gains `"watch"`; `parseNote` accepts it.
2. `digest.ts`: `DigestInput.trigger`, switching source + Context wording.
3. `reader.ts`: memo banner label for the new source.
4. `watcher.ts`: `readWatchConfig` (pure, env in), `decideWatch` (pure), and
   `registerWatcher` wiring — all pi imports type-only so it is testable.
5. `index.ts`: one `registerWatcher(pi, state)` call. Stays wiring-only.
6. Tests: `watcher.test.ts` (config + decision), `watcher-wiring.test.ts`
   (modes end-to-end against a fake `pi`), plus updates to notes/digest/reader
   tests for the new source.
7. Verify: extension vitest config + `tsgo --noEmit`; manual smoke in tmux with
   a deliberately low threshold.
8. DESIGN.md section, BACKLOG.md item marked shipped.

## Blast radius

`.pi/extensions/handoff/` only, plus the two fork docs. No `packages/` change,
so `npm run check` is unaffected (it does not reach `.pi/` anyway).

## Notes from the build

- This file lives in `docs/build-plans/`, not `docs/plans/`: upstream's
  `.gitignore` ignores `plans/` at any depth, so a plan written there is
  untracked and invisible to review.
- The first live smoke reported `Context is 0% full` at a sub-1% threshold.
  Percent rendering now keeps one decimal below 10 — a rounded-to-zero
  measurement reads as broken rather than small.
