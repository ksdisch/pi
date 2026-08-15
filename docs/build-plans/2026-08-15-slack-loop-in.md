# Slack/Telegram loop-in at decision points — design

2026-08-15. Design pass for the BACKLOG.md item; build is a separate session.

## Problem

Sessions now run unattended (successor spawning and retirement, PRs #18/#19).
When one reaches a decision point only Kyle can resolve, it blocks or ends
silently, and Kyle learns about it whenever he next opens a terminal. Two
concrete cases from this repo's own history: a pilot orchestration finishes
both runs with four reports written and nobody is told; an autonomous build
hits an "ask before removing functionality" gate and parks for hours.

## Design: bridge the intercom, don't teach every session a platform API

One new extension, `.pi/extensions/loop-in/`, that bridges the **existing
intercom protocol** to one external messaging platform.

- **Sessions do nothing new.** A session that needs Kyle does
  `intercom_send` to a conventional channel named `kyle` — exactly like
  messaging any peer — and, if it wants an answer, `intercom_wait`s there.
  The teaching cost inside prompts and skills is one line.
- **The bridge watches `.pi/intercom/kyle/`** and forwards each new message
  outbound, prefixed with repo basename and sender alias. Replies (v2) are
  written back into the channel as ordinary message files from alias `kyle`,
  so a waiting session's `intercom_wait` hears them with no new machinery.
- **Why a bridge instead of per-session platform clients:** credentials live
  in one place; the file channel is already ordered, atomic, and debuggable
  (`ls` and `cat`); and the watcher/wait semantics — including the wait-start
  boundary rule PR #29 paid for — are reused, not re-learned.
- **Who hosts the bridge:** the extension inside any live session, with a
  lockfile (`.pi/intercom/.bridge-lock`, holder pid + heartbeat) so exactly
  one session forwards; plus a tiny standalone `bridge.mjs` entry for when no
  session should own it (e.g. during a pilot, where seats are transient).

## Platform: Telegram first, Slack as a later port

- **Telegram Bot API:** one bot token (via @BotFather), one chat id; outbound
  is a plain HTTPS `sendMessage`, replies are the same token's `getUpdates`
  long-poll. No app review, no OAuth, no workspace admin, no public URL.
- **Slack:** needs an app, bot token, granted scopes, and for replies either
  Socket Mode (a websocket dependency) or the Events API (a public URL).
  Heavier on every axis; wins only if being inside Kyle's existing workspace
  matters more than setup cost.
- **Recommendation:** Telegram for v1 — outbound and reply-back are both
  trivial with one credential pair. The bridge's platform surface is two
  functions (`sendOut(text)`, `pollReplies()`), so a Slack port slots in
  behind the same interface without touching the intercom side.

## v1 scope

- Outbound only, plus the reply-back design held ready. Any message on the
  `kyle` channel goes out, length-capped consistent with intercom's 2000-char
  delivery cap.
- Decision points that send, in order of integration cost: (a) an explicit
  ask — a session sends and then waits (prompt/skill teaching only, no code);
  (b) handoff written / session retiring — the handoff extension already owns
  those moments, one `intercom_send` added later; (c) pilot orchestration
  end. v1 ships (a); (b) and (c) are one-line follow-ups.
- **Credentials (Kyle-action, blocking the build):** create the bot with
  @BotFather and keep the token; send the bot one message, read the chat id
  from `getUpdates`; export as `PI_LOOPIN_TELEGRAM_TOKEN` and
  `PI_LOOPIN_TELEGRAM_CHAT` (shell profile — never committed). The extension
  no-ops with a startup notice when either is unset.

## v2 sketch: reply-back

The bridge long-polls `getUpdates`; a reply from Kyle's chat id (checked —
anything else is dropped) becomes a message file from alias `kyle` on the
channel, and a waiting session's `intercom_wait` returns it. An idle session
gets it steered in by the ordinary watcher. No session-side changes at all.

## Open questions for the build session

- Lockfile takeover rules when the bridging session dies mid-heartbeat.
- Whether `run-pilot.sh` orchestration should auto-send its end-of-run
  summary in v1 or wait for (c).
- Formatting: plain text first; Telegram markdown only if it earns its
  escaping rules.

## Run-config note

Build is well-specified after this design; the judgment calls are made above.
Recommended: **Opus 5, effort high**.

`cd ~/Projects/pi && claude --model claude-opus-5 --effort high`
