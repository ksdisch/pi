# Intercom Extension — v1 Design

## What this is

Live session-to-session messaging for pi sessions running in the same project
directory. Two (or more) sessions join a named channel and exchange messages like
humans in a chat: a question asked by one wakes the other, which answers, which wakes
the first. No sockets, no server, no daemon — the transport is one JSON file per
message under `<cwd>/.pi/intercom/<channel>/`, and delivery is a poll loop.

Two driving use cases (Kyle, 2026-08-11):

1. **Handoff Q&A.** Session B starts from a handoff note (see the sibling `handoff`
   extension) and has clarifying questions. If session A is still open, B asks on a
   channel and A answers before B commits to a direction. (When A is already gone,
   the handoff extension's `ask_predecessor` tool answers from A's transcript
   instead — the two features deliberately compose.)
2. **Co-op playtesting.** Two sessions test a two-player game (Constellation: one
   drives the laptop view, one the phone view), coordinating in real time
   ("casting Freeze Stars — go"), then report back.

## Why polling, not push

Agents don't need millisecond latency; they need reliable ordered delivery with zero
infrastructure. A 1.5 s poll interval is indistinguishable from instant next to an
LLM turn, and files-on-disk means the whole system is debuggable with `ls` and `cat`.
pi's `pi-server` package was considered and rejected for v1: it is explicitly
experimental ("may change or be removed without notice"), and this extension should
not couple to it.

## Storage layout

```
<cwd>/.pi/intercom/
  <channel>/                                  one directory per channel
    2026-08-11T10-00-00-000Z_3f430270_000000.json   one file per message
```

- Filename = sanitized ISO timestamp + *last* 8 chars of sender session id (the uuidv7
  tail is random; the head is a launch-time clock two same-minute sessions share) +
  a per-process sequence. Lexicographic order ≈ delivery order.
- A reader's resume state is a **set of seen filenames**, deliberately not a
  "greatest filename" watermark: a filename is stamped before the rename that makes
  it visible, so a slow write (or a backwards wall-clock step) can surface a file
  below a watermark — which would skip it *forever*. A set delivers it late instead.
- One file per message (atomic `.tmp` + rename) means concurrent writers can never
  interleave bytes; there is nothing to lock.
- Message = JSON: `schema` (`pi-intercom/v1`), `channel`, `sender` (full session id),
  optional `alias` (single-line, ≤32 printable chars — enforced on write *and* read,
  because the alias lands inside the delivery banner and a multi-line one could forge
  message headers), `created` (ISO), `text`. Files failing validation are marked seen
  and left in place.
- `.git/info/exclude` gets `**/.pi/intercom/` appended (same mechanism, and the same
  reasoning, as the handoff extension's `notes.ts` — see the comment there). The
  git-exclude helper is *duplicated*, not imported: extensions are self-contained
  units, and importing across `.pi/extensions/` siblings would couple this
  extension's load to the other's presence.

## Delivery semantics

- **Joining** a channel (via `/intercom join`, or automatically by using either tool
  on it) starts with an empty seen-set = the full existing backlog is delivered.
  This is deliberate: a question sent *before* its answerer joined must still arrive.
  Delivery is bounded, though — one injection carries at most the newest **50**
  messages, each body head-capped at **2000 chars**, with an "N older omitted" line —
  so a stale channel cannot blow the joiner's context. `/intercom clear` resets a
  channel between runs (settled `.json` only; a peer's in-flight `.tmp` is left
  alone).
- **Own messages are never delivered back** (filtered by `sender`), but they are
  marked seen.
- **The watcher** (one `setInterval`, 1.5 s, `unref()`ed so it can never hold pi's
  exit open, and torn down on `session_shutdown` so reload/new-session cannot leak
  live timers bound to dead runtimes) scans every joined channel and injects anything
  new via `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`: an idle
  session wakes up and responds; a busy one sees the message before its next LLM
  call. Delivered names are marked seen only *after* the send call returns, so a
  synchronous send failure is retried next tick. `pi.sendMessage` is fire-and-forget
  inside pi, so an **asynchronous** delivery failure is unobservable here and would
  lose those messages — accepted for v1: it requires pi's own message queue to fail,
  and the transcript on disk still holds the message for manual recovery.
- **`intercom_wait`** marks its channel `waiting`, which keeps the watcher out of the
  way — otherwise one message could be delivered twice (once as the tool result, once
  as an injected memo). The tool and the watcher share the same per-channel seen-set.
- Watcher failures never throw (an interval callback that throws takes down the
  process); per-tick errors are aggregated once at the end of the tick — so one
  channel's clean pass cannot wipe another's error — and surfaced by
  `/intercom status`.

## Surface

Tools (LLM):
- `intercom_send { channel, message, alias? }` — write one message; auto-joins.
- `intercom_wait { channel, timeout_seconds? }` — block (default 60 s, max 300 s)
  until a message arrives, the signal aborts, or the timeout passes; auto-joins.
  Waiting costs no tokens, which matters on free-tier models.

Commands (user):
- `/intercom join <channel> [as <alias>]` · `/intercom leave <channel>` ·
  `/intercom clear <channel>` · `/intercom status`

Renderer: `customType: "intercom"` messages get the same boxed, accent-banner
treatment as handoff memos, so injected traffic is visually distinct from the user's
own prompts.

## Trust boundary

Joining a channel means trusting whatever can write into
`<cwd>/.pi/intercom/<channel>/`: a delivered message wakes an idle agent and starts a
turn, so any process with write access to the project directory (build scripts, npm
lifecycle hooks, tools the agent itself runs) could speak on a joined channel. That
is the feature's nature, not an oversight — the normal peers are the same user's own
sessions. Mitigations in place: aliases cannot span lines or exceed 32 chars (no
banner forgery), each delivery's banner and closing fence carry a caller-generated
nonce a message body cannot predict (so a body cannot pose as the end of the batch
plus further traffic), and nothing is delivered from channels a session hasn't
joined. Not mitigated: a message body is peer-written free text — it can still fake
`From …:` blocks *inside* its batch, and the receiving model will read it as
conversation. Do not join channels in untrusted working directories.

## Known limits (accepted for v1)

- **Same machine, same project cwd.** The mailbox is a directory; sessions on
  different machines or in different checkouts don't see each other.
- **`/reload` drops joined channels** (extension state is in-process). Rejoin by hand
  or via a tool call.
- **Messages accumulate** until `/intercom clear`. No TTL, no size cap: v1 traffic is
  small, human-supervised, and visible on disk.
- **No addressing beyond channels.** Everyone on a channel sees everything; two-party
  use is by convention (one channel per pair). Fine at this scale.

## Verification

- `store.ts` and `format.ts` have no pi imports and are covered by unit tests
  (round-trip, seen-set semantics including late out-of-order arrivals, corrupt-file
  skip, clear, git-exclude idempotence, rendered text).
- `index.ts` (tool/command/watcher wiring) is exercised interactively; it contains no
  logic beyond wiring that isn't already under test. Same trade the handoff
  extension's DESIGN.md documents for its `index.ts`.
- CI: `.github/workflows/intercom-ext.yml`, a sibling of `handoff-ext.yml`, runs the
  unit tests and a typecheck against pi source on every push/PR to main.
