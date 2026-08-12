# Draft upstream issue — expose `newSession()` on `ExtensionContext`

**Status: draft, not posted.** `CONTRIBUTING.md` auto-closes PRs from contributors
without `lgtm`, and earendil-works/pi#7968 and #7922 — both yours — were closed by
that bot, so the gated path is a Contribution Proposal issue first. Kyle posts this himself
when he wants to; nothing here goes to `earendil-works/pi` automatically.

Use the **Contribution Proposal** template
(`.github/ISSUE_TEMPLATE/contribution.yml`). The three fields below map to its three
questions. It asks to be kept to one screen and written in your own voice — treat
the text below as raw material to say in your own words, not as copy to paste
verbatim.

The corresponding fork commits are `1fb575833` (the patch) and `8362ff843` (the
JSDoc, after review), on branch `feat/expose-newsession-to-events`.

---

## What do you want to change?

Move `newSession()` from `ExtensionCommandContext` to `ExtensionContext`, so
extension event handlers can call it. Two files:

- `packages/coding-agent/src/core/extensions/types.ts` — the declaration moves.
- `packages/coding-agent/src/core/extensions/runner.ts` — the graft moves from
  `createCommandContext()` into `createContext()`.

`fork`, `switchSession`, `navigateTree`, and `reload` stay command-only.

## Why?

An extension can already detect that a session is finished — context usage past a
threshold on `agent_settled`, or a handoff note that another session has consumed —
but it cannot act on it, because event handlers get the plain `ExtensionContext`.
The detection and the action are one decision, split across two context types.

Nothing is missing at runtime. Every mode already binds a real handler
(`interactive-mode.ts`, `print-mode.ts`, and `rpc-mode.ts` all pass
`commandContextActions` with `newSession: runtimeHost.newSession`), and
`createCommandContext()` only grafts what the runner already holds onto a context
built by `createContext()`. This moves that one graft; it adds no machinery and no
new binding.

I use this for autonomous session continuation: at a context-fullness threshold the
extension writes a handoff note and starts the successor with that note's opening
prompt, so long work continues across sessions without a person present. It works
in `-p` as well as the TUI. Happy to keep it in my fork if you would rather the core
not grow this surface — the reason to offer it is that the constraint looked like an
API boundary and turned out to be one graft's placement.

## How?

The move itself is mechanical. Two things worth flagging, both of which I hit:

1. **Two hand-built `ExtensionContext` objects need the new member**: the shortcut
   context in `interactive-mode.ts` (`setupExtensionShortcuts`) and one test stub in
   `test/trigger-compact-extension.test.ts`. In the mode file I routed both it and
   the bound action through one private method, so the status-indicator clearing and
   the fatal-error handling do not drift apart.

2. **`newSession()` must not be called from inside an agent run**, and after the
   move the plain context is also what tool execution and the in-run events
   (`tool_call`, `tool_result`, `before_agent_start`, `session_before_compact`) are
   handed. A tool that calls it deadlocks: `teardownCurrent` → `session.abort()` →
   `waitForIdle()` waits on `_isAgentRunActive`, which only clears in
   `_runAgentPrompt`'s `finally`, which is waiting on that tool's `execute`. I
   documented this on the declaration rather than guarding it, because a naive
   `!isIdle` rejection would break a legitimate case that works today: `abort()`
   fires the agent's signal before awaiting idle, so replacing a running session from
   *outside* the run is fine — that is `/new` typed mid-stream. Telling "inside the
   run" from "outside while a run is active" needs async-context tracking, which
   seemed like more than this change should carry. If you would rather have the
   guard, or different wording, I will write it either way.

`npm run check` and `./test.sh` both pass on the change.
