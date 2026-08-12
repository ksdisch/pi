# Session Handoff Extension — v1 Design

Status: **approved design, not yet built** · Author: Kyle Disch (decisions) + Claude (spec) · Date: 2026-08-10

## What this is

A pi extension that automates session-to-session handoff. Every session leaves a
durable **handoff note** on disk — either a rich, LLM-composed one via `/handoff`,
or a mechanical digest written automatically when the session ends. New sessions
auto-detect the newest pending note and inject it as a briefing alongside the
user's first message.

This differs from upstream's `examples/extensions/handoff.ts`, which is an
in-process, interactive-only baton pass (generate prompt → edit → `ctx.newSession`)
that writes nothing to disk and cannot survive process exit. Ours is a dead drop:
it works across process boundaries, in non-interactive modes, and without the
user remembering to do anything.

### Locked decisions (Kyle, 2026-08-10)

1. **Storage:** project-local `.pi/handoffs/` with dated history (not latest-only).
2. **Ingestion:** first-message memo (`custom_message`, `deliverAs: "nextTurn"`).
3. **Consumed notes:** archived, never deleted.
4. **Auto-note at shutdown:** mechanical digest; no LLM calls in the exit path.
   `/handoff` is the rich, LLM-composed path.
5. **Format:** Markdown + YAML frontmatter.
6. **Forward-compat requirement:** every note carries a `kickoff` field — a
   ready-made opening prompt a future autonomous spawner can use to start the
   successor session (v2 north star: sessions detect stopping points / context
   fullness, spawn successors, ping Kyle via messaging when decisions are needed).

## Storage layout

```
<project>/.pi/handoffs/
  2026-08-10T22-15-00-000Z_a1b2c3d4.md     # pending note(s); newest = current
  archive/
    2026-08-09T18-02-11-421Z_99ffee01.md   # consumed or superseded notes
```

- Filename mirrors pi's session-file naming: ISO timestamp (`:`/`.` → `-`) +
  `_` + first 8 chars of the *writing* session's id. Lexicographic sort = age sort.
- **Pending vs consumed is encoded by location** (top level vs `archive/`), not a
  status field. On archive, `consumed_by` / `consumed_at` (or `superseded_by`)
  frontmatter is appended for audit.
- All writes are atomic: write to `<name>.md.tmp`, then `rename()`. No reader can
  ever see a half-written note.
- **Git hygiene:** the writer idempotently appends `.pi/handoffs/` to
  `<repo>/.git/info/exclude` (local-only ignore; never touches the project's
  tracked `.gitignore`). Skipped when cwd is not a git repo. We ignore
  `.pi/handoffs/` specifically — never all of `.pi/`, which some repos track
  (including this one).
- Scope is exact-cwd: notes are found by scanning `<ctx.cwd>/.pi/handoffs/`.
  Running pi from a subdirectory won't find project-root notes (v1 limitation;
  walk-up detection is a possible v1.1).

## Note format

```markdown
---
schema: pi-handoff/v1
session_id: 019feda9-55bc-797d-8b97-4fe03f430270
session_file: /Users/kyle/.pi/agent/sessions/--...--/2026-08-10T21-52-05-564Z_019feda9....jsonl
cwd: /Users/kyle/Projects/foo
created: 2026-08-10T22:15:00.000Z
source: command            # "command" (/handoff, LLM-composed) | "digest" (shutdown, mechanical)
                           # | "watch" (context-fullness watcher, mechanical, mid-session)
model: google/gemini-3.6-flash
kickoff: "Continue implementing the reader module; start by wiring archive-on-delivery."
---

## Context
What we were doing, decisions made, key findings.

## Next steps
The concrete task the successor should pick up.

## Files touched
- read: path/a.ts, path/b.ts
- modified: path/c.ts

## Last exchange        (digest-source notes only)
**User:** <last user message>
**Assistant:** <first lines of last assistant reply>
```

Frontmatter is machine-read by the extension (schema check, kickoff extraction,
consumed stamping); the body is for humans and for the successor's LLM context.
A note that fails frontmatter parsing is treated as not-pending: warned about
once, left in place, never ingested or archived.

## Components and their exact pi hooks

The extension is a standard jiti-loaded factory (`export default function (pi: ExtensionAPI)`),
developed at `.pi/extensions/handoff/` in this fork (auto-loads when running pi
here — instant dogfooding), later symlinked from `~/.pi/agent/extensions/handoff`
for all-projects use. Pi's loader de-dupes by resolved path, so the symlink and
the project-local copy never double-load.

```
.pi/extensions/handoff/
  index.ts        # factory: registers command + event hooks, wires modules
  notes.ts        # note types, frontmatter serialize/parse, atomic write, archive ops
  digest.ts       # session entries → mechanical digest fields (pure functions)
  compose.ts      # /handoff LLM composition (prompt + ctx.modelRegistry.complete)
  reader.ts       # pending-note detection, memo injection, archive-on-delivery
  ghost.ts        # ask_predecessor: answer questions from the predecessor's transcript
  watcher.ts      # context-fullness watcher: config, threshold decision, agent_settled wiring
  DESIGN.md       # this document
```

No npm dependencies — `node:fs`/`node:path` plus `@earendil-works/pi-coding-agent`
imports only. Keeps installation = "copy or symlink the folder."

### Writer A — `/handoff [goal]` (rich, LLM-composed)

- **Hook:** `pi.registerCommand("handoff", { handler })` — handlers get
  `ExtensionCommandContext`. The name is free (upstream's example lives in
  `examples/` and is not auto-discovered; if a user loads both, pi suffixes
  `/handoff:1`, `/handoff:2` rather than colliding).
- **Gather:** `ctx.sessionManager.buildContextEntries()` — *not* the hand-rolled
  branch walk upstream's example uses (it duplicates compaction logic and has
  drifted before). Serialize with the exported `convertToLlm` +
  `serializeConversation` helpers. Compaction-aware is right *here* because the
  serializer turns a compaction entry into a summary message, so elided history
  still reaches the composer; Writer B needs the opposite (see below).
- **Compose:** one-shot `ctx.modelRegistry.complete(ctx.model, …)` with
  `cacheRetention: "none"` and a fresh `sessionId` (uuidv7) so the call never
  pollutes the user's session. System prompt requests the note body sections plus
  a one-line `kickoff`. The optional `goal` argument steers "Next steps";
  without it, the prompt asks for state summary + natural next step (upstream
  hard-requires a goal; we don't — automation is the point).
- **Review:** in TUI mode, show the draft in `ctx.ui.editor()` for edit/approval
  before writing. When `ctx.hasUI` is false (`-p` / JSON modes), skip review and
  write directly — degrade gracefully where upstream hard-fails.
- **Write:** atomic write to `.pi/handoffs/`, then `ctx.ui.notify` the path.
- **Optional successor spawn:** in TUI mode, `ctx.ui.confirm("Start successor
  session now?")` → `ctx.newSession({ parentSession, withSession })`. This
  composes with the reader for free: `newSession` fires `session_start
  {reason:"new"}`, our own reader detects the just-written note and injects it.
  All post-switch work uses only the `withSession` callback's fresh context
  (captured `ctx`/`pi` are invalidated after replacement — the documented
  footgun that has bitten upstream's example before).
- Sets an in-memory `wroteNoteThisSession` flag (see Writer B).

### Writer B — shutdown digest (mechanical safety net)

- **Hook:** `pi.on("session_shutdown", handler)`, acting **only when
  `event.reason === "quit"`** — the event also fires for `reload`/`new`/`resume`/
  `fork`, which must not each drop a note.
- **Skip when:** `wroteNoteThisSession` is set (the `/handoff` note is richer; a
  later digest would supersede it as "newest" with worse content — accepted v1
  simplification: work done *after* `/handoff` but before quit isn't re-captured);
  no assistant message exists on the active branch (nothing happened — also covers
  the fact that pi's session file isn't even flushed to disk until the first
  assistant reply); or `getSessionFile()` is undefined (`--no-session` ephemeral
  runs — the user asked not to be recorded; honor it).
- **Entry source:** `ctx.sessionManager.getBranch()` — the active leaf-to-root
  path, every entry type, no compaction fold. Not `getEntries()` (flat
  append-order across *all* branches, so a `/tree` rewind leaks abandoned work
  into the digest) and not `buildContextEntries()` (drops everything before
  `firstKeptEntryId`; since this walk reads only `message` entries, that would
  silently shrink "files touched" to the post-compaction tail).
- **Digest fields** (pure in-memory walk of `ctx.sessionManager` — no LLM, no
  network, bounded, idempotent; a hung shutdown handler hangs pi's exit):
  last user message; first ~15 lines of last assistant reply; files touched
  (walk assistant `toolCall` content blocks for `read`/`write`/`edit` path
  arguments, deduped into read vs modified); current model; session file path +
  id; mechanical `kickoff` = `"Continue: <first line of last user message>"`.
- **Files-touched bounds:** each list is capped at 20 paths and 600 characters,
  with an `(and N earlier omitted)` suffix. The cap keeps the **most recently
  touched** paths, not the first: the walk above is deliberately un-folded, so on
  a compacted session the list is long, and the successor needs the files that
  were in flight at exit rather than the ones opened while getting oriented.
  Paths are never truncated mid-string — one that cannot be shown whole is
  omitted and counted, since a chopped path still reads as a real one.
- Works identically in all modes (`notify` only when `ctx.hasUI`).
- Known limits, accepted: shutdown is best-effort in pi (fatal-error exits and
  SIGKILL skip it). `/handoff` is the reliable path; this is the seatbelt.

### Reader — detect + inject + archive

- **Detect** on `pi.on("session_start")` for `reason` `"startup"` or `"new"`
  only. `resume`/`fork` sessions carry their own live context — injecting another
  session's briefing there invites confusion (judgment call; revisit if wrong).
  Scan `<ctx.cwd>/.pi/handoffs/*.md`, parse frontmatter, pick the newest valid
  pending note.
- **Inject:** `pi.sendMessage({ customType: "handoff", content: memo, display:
  true }, { deliverAs: "nextTurn" })`. The memo = banner line ("Handoff from
  session <id-prefix>, ended <time>") + note body + session-recording pointer +
  one line listing any older pending notes. `nextTurn` parks it until the first
  real prompt — no LLM call is burned on an idle session, and the memo persists
  as a first-class `custom_message` entry in the successor's transcript. Crucially
  this is **spawn-agnostic**: the "first prompt" can come from a human, `pi -p`,
  RPC, or a future autonomous spawner — the memo attaches regardless.
- **Archive on delivery, not on detection:** `session_start` only *queues* the
  memo and remembers the note path in memory. The first `before_agent_start`
  (i.e., the user actually submitted a prompt — the memo is now really being
  delivered) moves **all** pending notes to `archive/`: the ingested one stamped
  `consumed_by: <session id>` / `consumed_at`, older ones stamped
  `superseded_by: <ingested note filename>`. If the session is opened and quit
  without a prompt, the note stays pending for the next session — the briefing
  is never lost to an aborted start.
- **Concurrency:** two sessions starting at once may both queue the same note;
  the second archive `rename()` fails ENOENT and is swallowed. Both ingesting
  the same briefing is acceptable; losing it is not. (Pi's v3 session layer has
  no locking either; atomic rename is our only primitive and it's sufficient.)
  Separately, a note whose writer is *still running* — only the watcher writes
  those — is skipped rather than ingested; see the watcher section.

### Nice-to-have (build only if trivial): `pi.registerMessageRenderer("handoff", …)`
for a styled memo box in the TUI. Default `custom_message` styling is acceptable
for v1.

## Failure modes considered

| Failure | Behavior |
|---|---|
| Corrupt/unparseable note | Warn once, leave in place, never ingest/archive |
| Shutdown handler slow/hung | Impossible by construction: no network, no LLM, in-memory walk + one atomic write |
| Session file not yet on disk | Digest skips (no assistant message ⇒ nothing to hand off) |
| `.jsonl` hazard in session dirs | N/A — notes are `.md` in the project, never in `~/.pi/agent/sessions/` |
| Stale ctx after `newSession` | All post-switch work confined to `withSession` callback |
| Extension throws anywhere | Pi contains it (logged, other extensions unaffected) — but every handler still guards its own I/O |
| Both our extension and upstream example loaded | Commands suffix to `/handoff:1`, `/handoff:2`; no data conflict (example writes nothing) |

## Build plan (value-ordered slices)

1. **`notes.ts` + Writer B** — storage, format, atomic ops, shutdown digest.
2. **Reader** — detection, memo injection, archive-on-delivery.
   *After slices 1+2 the automated loop already works end-to-end with zero LLM involvement.*
3. **Writer A** — `/handoff` LLM composition, editor review, optional successor spawn.
4. **Polish** — git-exclude hygiene, older-notes notice line, message renderer.

Each slice: unit tests for the pure modules (`notes.ts` parse/serialize
round-trip, `digest.ts` entry-walking against a fixture session JSONL — the real
specimen at `~/.pi/agent/sessions/--Users-kyledisch-Projects-pi--/` is a good
fixture source), plus a manual smoke via `pi -e .pi/extensions/handoff/index.ts`
in a scratch project. LLM smoke tests use Google Gemini free tier only — never
Anthropic subscription auth (bills per-token).

## Verification gates

This extension lives outside `packages/`, so none of the repo's own gates reach it:
`.pi/**` is absent from `tsconfig.json`'s `include` and `biome.json`'s `files.includes`,
and it is not an npm workspace, so `npm run check` and `npm test` skip it silently.

Tests and typecheck are gated by their own workflow, `.github/workflows/handoff-ext.yml`,
kept as a separate file so rebasing this fork onto upstream pi never conflicts there. Run
the same two commands locally from the repo root:

```
node node_modules/vitest/dist/cli.js --run --config .pi/extensions/handoff/vitest.config.ts
npx tsgo --noEmit -p .pi/extensions/handoff/tsconfig.json
```

Formatting is the remaining gap: `biome check` ignores the path by config, and covering it
would mean editing `biome.json` — a shared upstream file. Format by hand when needed with
`--config-path` pointing at a copy of `biome.json` whose `files.includes` is
`["**/*.ts", "!**/node_modules/**/*"]`.

### What the unit tests do *not* cover: `index.ts`

`index.ts` is the one module with no test file, and that is a standing decision rather than an
oversight. It has runtime (non-type) imports from `@earendil-works/pi-ai`, `pi-coding-agent`, and
`pi-tui`; importing it from a test under this vitest config fails with `Cannot find module
'…/handoff/string_decoder'`. Every other module keeps its pi imports type-only, which is why they
are importable — `reader-wiring.test.ts` works only because `reader.ts` obeys that rule.

**The blocker is a vitest resolution setting, not an architectural one, and the difference matters
— an earlier draft of this section claimed the latter and was wrong.** Adding
`test.server.deps.external: [/.*/]` to `vitest.config.ts` makes `index.ts` importable with no
source change at all (measured: the full suite plus one added `index.ts` import probe passes with
the key, and the same probe fails without it — stated relatively because the suite's own count has
since grown past the 104 recorded at the time). No
extraction is required. What that key costs is the reason it is not taken: it hands every `.ts` in
this suite to Node's type-stripping instead of vite's transform, changing how all five existing
test files are loaded to buy coverage of one. That tradeoff deserves its own change, evaluated on
its own, rather than riding along with a bug fix.

So for v1: keep `index.ts` thin — registration and wiring, with the logic it wires living in the
tested modules — and cover it by manual smoke run (`pi-test.sh -e .pi/extensions/handoff/index.ts`,
Gemini free tier). The exposure is real and worth naming: the editor round-trip, the
successor-spawn confirm, and the `mode`-vs-`hasUI` gate are verified by hand or not at all.
Anything that grows past wiring should move out of `index.ts` rather than being tested in place.

## Ghost responder — `ask_predecessor` (added 2026-08-11)

The successor's escape hatch when the briefing isn't enough: a tool that answers
clarifying questions **as the previous session**, from that session's saved
transcript (`session_file` in the note frontmatter). One isolated LLM call
(`cacheRetention: "none"`, own session id — same isolation as `/handoff`'s
composer) over transcript + question; no coordination with the predecessor, which
may be days gone. When both sessions are alive simultaneously, the live channel is
the sibling `intercom` extension — the two compose rather than compete.

- **Hook:** `pi.registerTool("ask_predecessor", …)`; errors are thrown (pi's
  tool-error contract), never returned as text.
- **Predecessor selection** (`findPredecessor`, disk-scan so it survives
  `/reload`): the archived note stamped `consumed_by` = this session, else the
  newest pending note, else the newest archived note; notes without
  `session_file` — and notes *written by the asking session itself* (a `/handoff`
  without quitting leaves one pending; answering as your own ghost would launder
  your own context as another session's testimony) — are skipped everywhere.
- **Transcript rendering** (`renderTranscript`): active branch only (walk
  `parentId` up from the last entry — same rewind reasoning as the digest's
  `getBranch()`, with a visited-set guard because the path comes from a
  hand-editable note), user/assistant text plus `[ran <tool> <args-preview>]`
  markers (200 chars), `[<tool> result] <head-preview>` lines (300 chars),
  `[thinking]` previews (500 chars — "why did you rule that out?" often lives
  there), and `[session summary]` lines from compaction/branch-summary entries —
  tail-capped at 150k chars overall.
- `notes.ts` gained `listArchivedNotePaths`; everything else is additive.

## Context-fullness watcher (added 2026-08-11)

A note at the high-water mark rather than at the exit.

**Not** because compaction costs the shutdown digest anything — it does not. The digest
reads `getBranch()`, the full root-to-leaf path, which keeps every pre-compaction entry
(the reason it uses `getBranch()` over `buildContextEntries()` is spelled out in
`index.ts`). An earlier draft of this section claimed otherwise and was wrong. The
reasons that hold up:

- **The shutdown digest is best-effort.** A crash, a SIGKILL, or a closed terminal never
  reaches `session_shutdown` — and a session at the end of its context window is exactly
  where those happen. A watch note is already on disk by then.
- **Compaction degrades the session's own working context.** Once it has run, the moment
  to hand off has passed; the successor inherits a summary of a summary.
- **It is the stopping-point detection** an autonomous spawner needs.

- **Hooks — two, because one is not enough:**
  - `pi.on("agent_settled", …)`, the ordinary crossing.
  - `pi.on("session_before_compact", …)`. pi compacts *inside* the agent run:
    `_checkCompaction` is called from `_handlePostAgentRun` and `_emitAgentSettled` only
    runs in the `finally` after that loop. So a run that goes from under the threshold to
    over the compaction trigger in one step reaches settle at `percent: null` — pi cannot
    price the new context until the next assistant reply — and settle alone would miss
    precisely the crossing this feature exists for. The compaction hook catches the same
    crossing a step earlier, with the pre-compaction branch handed to it by the event. It
    returns nothing (a truthy result there cancels the compaction) and never shows a
    dialog: compaction is already waiting on the handler.

  Handlers are awaited by `_emitAgentSettled`, so a dialog holds the settle path open —
  and with it interactive mode's `checkShutdownRequested()`. See the `propose` hazards
  below for why that is opt-in and time-bounded.
- **Settings** (environment, not CLI flags: the successor sessions this is groundwork
  for are spawned as child processes, which inherit env and not argv):

  | `PI_HANDOFF_WATCH` | At the threshold |
  |---|---|
  | `off` | nothing |
  | `notify` | report the crossing; write nothing |
  | `propose` | TUI: 3-way select — write the note / compose via `/handoff` / not now |
  | `auto` (default) | write the note, report the path |

  `PI_HANDOFF_WATCH_AT` is the percent, default 80. A value outside `(0, 100]` or an
  unknown mode falls back to the default **and warns once** — a typo that silently
  disables the watcher is the failure this exists to prevent.

  **Why `auto` is the default and `propose` is opt-in.** pi's extension selector is not an
  overlay: `showExtensionSelector` calls `disposeActiveSelector()`, clears the editor
  container and takes focus. So a dialog raised at an arbitrary settle (1) destroys a
  model or session picker the user already had open, (2) parks the settle path — and with
  it the shutdown check, so a quit pressed during the run waits behind a handoff prompt —
  and (3) in a scripted TUI (the tmux workflow `AGENTS.md` documents, the one agents use)
  swallows the next `send-keys` prompt, whose `Enter` confirms the highlighted row instead.
  Writing the note costs one file in a git-excluded directory and seizes nothing, so that
  is the default. When `propose` is asked for, the dialog carries a
  `PROPOSE_TIMEOUT_MS` timeout so (2) is bounded: an unanswered dialog dismisses itself and
  is read as "not now".

  Outside the TUI, `propose` degrades to `auto` rather than to silence. `-p`/JSON have no
  dialog surface at all, and RPC has one that a host may never answer — the same hazard
  that keeps `/handoff`'s editor review TUI-gated. A proposal nobody can answer loses the
  note; writing it costs a file.
- **Firing discipline:** at most once per crossing. Re-arms only once usage falls
  `REARM_MARGIN_PERCENT` (10) below the threshold — i.e. after a compaction, not while
  usage hovers at 79/81 across turns. Usage of `null` (between a compaction and the next
  assistant response, when pi cannot yet price the context) holds the armed flag as-is
  rather than treating unknown as low.
- **Skips:** when `/handoff` already wrote a note this session (a mechanical note would
  supersede a richer one as "newest pending" — same rule the shutdown digest follows);
  when `getSessionFile()` is undefined (`--no-session`), reported as a warning since the
  user asked for a note; when the branch holds no assistant message.
- **Does not set `wroteNoteThisSession`.** The session usually keeps working after the
  watcher fires, so the shutdown digest must still run at quit; its note is newer and the
  reader supersedes the watcher's. Both being pending at once is the designed outcome,
  not a leak.
- **A watch note's writer is usually still running** — the one note in this design whose
  session has not stopped. Concurrent pi sessions in one cwd are normal here
  (`AGENTS.md` § Git), and the reader gates only on `session_start` reason, so without a
  guard a sibling session would ingest another session's in-progress snapshot as its
  briefing and archive it `consumed_by` itself. So watch notes carry the writer's `pid`,
  and `scanPendingNotes` skips any note whose writer is a *different* live process
  (`isForeignWriterAlive`, `kill(pid, 0)`; EPERM counts as alive). Skipped, not consumed:
  the note stays pending, so once that process exits it becomes an ordinary pending note —
  which is exactly the crash-seatbelt case. Pid reuse can make a dead writer look alive;
  that direction leaves the note on disk to be read later rather than consumed by the wrong
  session now.

  "Different" is the load-bearing word. pi's successor sessions run **in-process**: `/new`
  and `ctx.newSession()` fire `session_start` with `reason: "new"` and the same pid, so a
  note carrying our own pid is the previous session in this process briefing this one — the
  whole point. A guard without that exception starves the successor it was built for, which
  is what the first draft of it did. The scan runs once, from `session_start`, and the
  watcher cannot write before a run has settled, so an own-pid note is never one this
  session wrote.
- **Note content:** the same mechanical `buildDigestNote`, with `trigger: "watch"` —
  `source: watch` in frontmatter and a Context section that says the session was still
  running. The shutdown wording ("written when the previous session exited") would be a
  lie mid-session, and a stale note that reads as a current one is worse than no note.

### Why the watcher cannot spawn the successor

`newSession()` lives on `ExtensionCommandContext`; event handlers are handed the plain
`ExtensionContext` (`runner.ts`: `createContext` vs `createCommandContext`). Nothing on
`ExtensionAPI` reaches it either. So the watcher offers the spawn instead of performing
it: the compose choice prefills `/handoff` into an empty editor, and `/handoff` — which
has a command context — composes the richer note and runs the existing spawn confirm. An
already-typed prompt is left alone; saving a keystroke is not worth clobbering the user's
text. Closing this gap is designed in the "Session lifecycle" section below — the
constraint turned out to be an exposure choice, not missing machinery.

### Verified how

`watcher.ts` keeps its pi imports type-only, so both halves are unit-tested:
`test/watcher.test.ts` (config parsing, threshold/re-arm decisions) and
`test/watcher-wiring.test.ts` (both triggers and every mode end-to-end against a fake `pi`,
asserting what reaches disk). Live smoke: `pi -p` with `PI_HANDOFF_WATCH_AT` set below 1%
wrote a real `source: watch` note, reported it on stderr, and the shutdown digest still
wrote its own note 1 ms later — the intended two-note outcome. The TUI select dialog itself
is the one path with no live coverage (no tmux on the machine that built this); it is one
`ctx.ui.select` call, covered by the wiring tests.

Note that a threshold at or below `REARM_MARGIN_PERCENT` (10) — which the smoke above uses
— can never re-arm, so the watcher fires exactly once for the life of that process. Fine for
a smoke run, wrong as a setting; a warning for it is an open follow-up.

## Session lifecycle — autonomous succession + retirement (added 2026-08-12)

Status: **approved design, not yet built** · Build plan:
`docs/build-plans/2026-08-12-session-lifecycle.md`

Closes the gap the watcher section names — the watcher detects the stopping point but
cannot act on it — and its inverse: a session whose work was picked up elsewhere sits in
its terminal window forever. Two capabilities, designed together because they share
signals (the `kickoff` field, the `consumed_by` stamp):

1. **Succession** — `PI_HANDOFF_WATCH=spawn`: at the threshold crossing, write the note
   *and* start the successor. No human confirm, all modes.
2. **Retirement** — a session whose handoff note was consumed by another session shuts
   itself down, and (by launch convention) its window closes with it.

### Scope decisions (Kyle, 2026-08-12)

1. Retirement = exit the pi process **and** close the Warp window. Session records in
   `~/.pi/agent/sessions/` are never touched — they are what `ask_predecessor` reads.
2. Succession = fork-local patch exposing `newSession` to event handlers, with the same
   diff offered upstream; the patch retires if the PR lands.
3. Window close = launch convention (`exec pi`), not AppleScript. An osascript helper
   for hand-started windows is out of scope, named as a possible follow-up.
4. Self-shutdown only. No session registry, no reaper; nothing ever signals another pid.
5. Spawn-mode notes are LLM-composed with mechanical fallback.

### The exposure patch

The constraint documented above ("Why the watcher cannot spawn the successor") is
narrower than BACKLOG item 1 assumed. `newSession` is not missing machinery: every mode
binds a real handler into the runner — `interactive-mode.ts`, `print-mode.ts`, and
`rpc-mode.ts` all pass `commandContextActions` with `newSession:
runtimeHost.newSession` — and `createCommandContext()` merely grafts what the runner
already holds (`runner.ts`, the `newSessionHandler` field) onto a context built by
`createContext()`. The patch moves that one graft: `newSession` joins the plain
`ExtensionContext`, next to `shutdown()`, which has lived there all along
(`types.ts:340`) — existing precedent that per-mode-wired session actions belong on
event contexts. `fork`/`switchSession`/`navigateTree`/`reload`/`waitForIdle` stay
command-only; nothing needs them.

Verified dead ends, recorded so nobody re-walks them: `pi.sendUserMessage` cannot reach
a command context (it calls `prompt` with `expandPromptTemplates: false`, deliberately
skipping command dispatch — `agent-session.ts`), and nothing on `ExtensionAPI`
dispatches a registered command programmatically.

Two upstream files change (`packages/coding-agent/src/core/extensions/runner.ts` and
`types.ts`); both join the rebase-sensitive list in `CLAUDE.md`. The same diff goes
upstream as a PR arguing the `shutdown()` precedent plus the autonomous-continuation
use case; per-event contexts are created fresh per emit, so the existing staleness
discipline already covers the new surface.

### Succession: `PI_HANDOFF_WATCH=spawn`

The watcher's mode table gains a row: `spawn` — everything `auto` does, then start the
successor. The flow at a settle crossing:

1. **Compose the note** via the `/handoff` composer (`compose.ts` is callable from the
   event context — `modelRegistry` is on the plain `ExtensionContext`). On any error —
   429, timeout — fall back to the mechanical digest note. A thin note plus
   `ask_predecessor` beats no successor; the chain must survive free-tier throttling.
2. **`ctx.newSession({ withSession })`** — in-process replacement: same window, same
   process, no clutter created.
3. **Inside `withSession`** (a `ReplacedSessionContext` — a full command context):
   `sendUserMessage(kickoff)`. The reader queued the memo at `session_start
   {reason:"new"}`, and the kickoff prompt is its delivery trigger, so briefing and
   marching orders arrive in the same first turn. This is the `kickoff` contract from
   locked decision 6 doing what it was stored for.

**Spawn only from the settle path.** The `session_before_compact` crossing fires
*inside* the agent run; replacing the session there is the stale-context footgun. That
crossing writes the note and sets a `spawnPending` flag; the run's own settle — which
always follows, `_emitAgentSettled` runs in the loop's `finally` — performs the spawn.

**Skips:** everything the watcher already skips, plus `hasPendingMessages()` — queued
follow-ups mean the session is not done. **Runaway guard:** a module-level generation
counter (extension instances survive `newSession`) caps spawns per process — default
10, `PI_HANDOFF_SPAWN_MAX` overrides, same parse-with-warn rules. At the cap, degrade
to `auto` behavior plus a notice. Each spawn requires a genuine threshold crossing, so
the counter is a backstop, not a governor.

The shutdown digest is unaffected: `newSession` fires `session_shutdown` with
`reason: "new"`, which Writer B already ignores.

### Retirement: `retire.ts`, `PI_HANDOFF_RETIRE`

The predicate for "this session's work was for-sure picked up": **an archived note
with `session_id` equal to the current session's id, carrying a `consumed_by` stamp.**
`superseded_by` deliberately does not qualify — superseded means a newer note won the
briefing slot, not that this session's work was ingested.

A consequence worth stating: watch notes cannot drive cross-process retirement. The
reader's liveness guard makes sibling processes *skip* a live writer's watch note, so
one can never be stamped `consumed_by` while its writer is alive to react. In practice
the predicate fires for `/handoff`-written notes — the deliberate cross-process handoff
path — which is the right shape: retirement follows an intentional handoff, not a
mid-session snapshot.

- **Polling starts lazily:** only a session that wrote a note this session is a
  candidate. A ~30 s `setInterval`, `unref()`ed and torn down on `session_shutdown` —
  the intercom watcher's discipline. The scan is cheap: note filenames embed the
  writer's session-id fragment, so it is one readdir plus frontmatter parses of
  own-session files only.
- **Modes** (same env parse-with-warn machinery as the watcher):

  | `PI_HANDOFF_RETIRE` | On predicate match |
  |---|---|
  | `off` | nothing |
  | `notify` (default) | "handoff consumed by <id>; this session can retire" |
  | `auto` | notify, 30 s grace, then `ctx.shutdown()` |

- **`auto` re-checks at grace expiry:** `isIdle()`, `!hasPendingMessages()`, and no
  session activity since the note was written. A session that kept working after
  handing off has outgrown its note — killing it would eat real work — so it downgrades
  to notify. `ctx.shutdown()` itself is graceful per-mode (the TUI's handler waits for
  idle).
- **Retirement suppresses the shutdown digest** (sets the same skip flag `/handoff`
  uses). Without this, the retiring session's exit would drop a fresh pending note
  re-advertising work that was already picked up — the next session would ingest its
  own predecessor's ghost. The no-activity-since-note guard means the digest could not
  contain anything the consumed note lacks.
- In-process successors never match: the poll compares against the *current* session
  id, and a replaced session has no actor left to retire.

### Window close — the launch convention (not a pi component)

pi can exit its process; the Warp window belongs to the shell. The convention:
launchers start sessions with `exec pi …`, making pi the window's root process, so
process exit ends the Warp session. That is a change to the `/launch` skill in
`~/Projects/claude-config` plus a one-time verification of Warp's close-on-exit
behavior — both build-plan items, neither in this repo. Hand-started windows degrade
honestly: notice, exit, shell prompt survives. If that residue matters in practice,
the osascript helper is the named follow-up.

### Safety posture

`spawn` and `auto` are both opt-in; the `notify` default is the dry-run period —
nothing acts autonomously until both are explicitly set. A retiring session's intercom
channels go silent with messages preserved on disk (matches intercom's known limits).
Free-tier budget: one composer call per spawn against ~20/day, with the mechanical
fallback keeping the chain alive when it throttles.

### Verified how (planned)

`retire.ts` keeps pi imports type-only: unit tests for config parsing and the
predicate, wiring tests against the fake `pi` (the `watcher-wiring.test.ts` pattern).
Spawn-mode wiring tests assert the settle-only rule, the generation cap, and the
compose-fallback. Live smokes in a scratch dir (`-e` with an absolute path, never the
repo cwd), Gemini free tier: the in-process chain end-to-end at a low threshold, and a
two-process retirement (one session consumes, the writer notifies/retires). Flagged
unknowns to verify during the build: whether `-p` print mode's process outlives a
spawned successor's run, and Warp's close-on-exit behavior for `exec`-rooted sessions.

## Explicitly out of scope for v1 (v2 hooks noted)

- Autonomous successor spawning — **designed 2026-08-12**, see "Session lifecycle"
  above (the `kickoff` field is the contract it consumes).
- Messaging integration (Slack/Telegram ping at decision points).
- Repo-scoped event ledger (the dated-history `handoffs/` dir is its seed).
- Walk-up note detection from subdirectories; cross-cwd note routing.

---

**Run-config note:** the v1 build this note originally launched has shipped. The
one unbuilt section is "Session lifecycle"; its build has its own run-config note
at the end of `docs/build-plans/2026-08-12-session-lifecycle.md` — launch from
there, not from this file.
