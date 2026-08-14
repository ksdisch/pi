/**
 * Intercom extension: live session-to-session messaging over a shared on-disk mailbox.
 *
 * Two pi sessions running in the same project join a named channel and talk: each
 * message is one JSON file under `<cwd>/.pi/intercom/<channel>/`, and every session
 * polls its joined channels, injecting anything new as a custom message that wakes the
 * idle agent (`triggerTurn`). No sockets, no server — latency is one poll interval,
 * which is real-time enough for agents. See DESIGN.md.
 *
 * Surface:
 * - Tools `intercom_send` / `intercom_wait` — how the LLM talks and listens in-turn.
 * - `/intercom join|leave|clear|status` — how the user wires a session up by hand.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { deliveredCount, formatIncoming } from "./format.ts";
import {
	clearChannel,
	collectNew,
	INTERCOM_SCHEMA,
	type IntercomMessage,
	isValidAlias,
	isValidChannel,
	listChannels,
	listMessageFiles,
	writeMessage,
} from "./store.ts";

const POLL_MS = 1500;
const WAIT_POLL_MS = 500;
const WAIT_DEFAULT_S = 60;
const WAIT_MAX_S = 300;

interface ChannelState {
	alias?: string;
	/**
	 * Filenames already handled. A set, not a "newest filename" watermark: filenames
	 * are stamped before the rename that makes them visible, so a slow write can
	 * surface *below* a watermark and be skipped forever. Empty = deliver the backlog.
	 */
	seen: Set<string>;
	/** True while an `intercom_wait` owns this channel; the watcher stays out of its way. */
	waiting: boolean;
}

interface IntercomState {
	joined: Map<string, ChannelState>;
	/** Captured from the latest `session_start`; the watcher tick has no event ctx. */
	cwd?: string;
	sessionId?: string;
	/** Per-process send sequence; orders same-millisecond sends from this session. */
	seq: number;
	/** Last watcher failure, surfaced via `/intercom status` — a watcher must never throw. */
	watchError?: string;
	/**
	 * True while an agent loop is running (`agent_start` → `agent_end`/`agent_settled`).
	 * The tick must not claim messages then: a steer delivery queued mid-run cannot
	 * surface until the run's next LLM call, but marking the message seen blinds an
	 * `intercom_wait` issued in that same run — the wait polls the shared `seen` set and
	 * runs its whole timeout deaf to a message that has factually arrived. Twelve-plus
	 * live instances of exactly that (60–94s of deafness each, manufactured
	 * `arm-timeout`s) are recorded in `.pi/playtest/PILOT-2026-08-14-run{6,7}.md`.
	 * Left unclaimed, the message is picked up instantly by any wait, or by the first
	 * tick after the run ends (≤ one poll interval) on the unchanged idle-wake path.
	 */
	agentActive: boolean;
}

function normalizeChannel(raw: string): string | undefined {
	const name = raw.trim().toLowerCase();
	return isValidChannel(name) ? name : undefined;
}

/** Nonce for one delivery's fence — unpredictable to message bodies (see format.ts). */
function newBatchId(): string {
	return Math.random().toString(36).slice(2, 10);
}

function join(state: IntercomState, channel: string, alias?: string): ChannelState {
	let entry = state.joined.get(channel);
	if (!entry) {
		entry = { waiting: false, seen: new Set() };
		state.joined.set(channel, entry);
	}
	if (alias) entry.alias = alias;
	return entry;
}

/** One watcher pass over every joined channel. Failures land in `watchError`, never throw. */
function tick(pi: ExtensionAPI, state: IntercomState): void {
	if (!state.cwd || !state.sessionId) return;
	// Mid-run the tick stands down entirely — see `agentActive` on IntercomState. The
	// cost is that a busy session now hears a message at its next `intercom_wait` or at
	// run end (+ ≤ one poll) instead of before its next LLM call; the benefit is that a
	// wait can never again run deaf to an already-arrived message.
	if (state.agentActive) return;
	const errors: string[] = [];
	for (const [channel, entry] of state.joined) {
		if (entry.waiting) continue;
		try {
			const collected = collectNew(state.cwd, channel, entry.seen, state.sessionId);
			// Own and corrupt files carry nothing to deliver — mark them seen right away.
			for (const name of collected.skipped) entry.seen.add(name);
			if (collected.delivered.length === 0) continue;
			pi.sendMessage(
				{
					customType: "intercom",
					content: formatIncoming(
						channel,
						collected.delivered.map((item) => item.message),
						newBatchId(),
					),
					display: true,
				},
				// steer + triggerTurn: an idle session wakes up and answers; a busy one sees
				// the message before its next LLM call instead of after the whole turn.
				{ deliverAs: "steer", triggerTurn: true },
			);
			// Marked seen only after the send call returned: a synchronous failure above
			// leaves the names unseen and the tick retries them. (sendMessage is
			// fire-and-forget inside pi, so an *async* delivery failure is not observable
			// here at all — accepted; see DESIGN.md.)
			for (const item of collected.delivered) entry.seen.add(item.name);
		} catch (err) {
			errors.push(`#${channel}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	// Set once per tick, outside the loop, so one channel's clean pass cannot wipe
	// another channel's error before /intercom status ever shows it.
	state.watchError = errors.length > 0 ? errors.join("; ") : undefined;
}

function registerWatcher(pi: ExtensionAPI, state: IntercomState): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	pi.on("agent_start", () => {
		state.agentActive = true;
	});
	// Both end events clear the flag: `agent_end` fires when the loop ends, and
	// `agent_settled` after retries/compaction/continuations settle — either alone could
	// be missed on an unusual path, and a stuck-true flag would mute the watcher forever.
	pi.on("agent_end", () => {
		state.agentActive = false;
	});
	pi.on("agent_settled", () => {
		state.agentActive = false;
	});
	pi.on("session_start", (_event, ctx) => {
		// Every reason, including resume/fork: whatever session is live now is the sender
		// identity and cwd the watcher must use.
		state.cwd = ctx.cwd;
		state.sessionId = ctx.sessionManager.getSessionId();
		if (timer) return;
		// unref: a forgotten channel must never hold pi's exit open.
		timer = setInterval(() => tick(pi, state), POLL_MS);
		timer.unref();
	});
	// Fires for quit AND for reload/new/resume/fork — every path that replaces this
	// extension instance. Without this, each replacement leaks a live interval bound
	// to a dead runtime (whose sendMessage then throws on every delivery attempt).
	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	});
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolvePromise) => {
		const timer = setTimeout(done, ms);
		function done(): void {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolvePromise();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

const SEND_PARAMS = Type.Object({
	channel: Type.String({ description: "Channel name, e.g. 'handoff' or 'constellation'" }),
	message: Type.String({ description: "The message to send" }),
	alias: Type.Optional(
		Type.String({ description: "Name to appear as on this channel from now on, e.g. 'laptop-player'" }),
	),
});

const WAIT_PARAMS = Type.Object({
	channel: Type.String({ description: "Channel name to listen on" }),
	timeout_seconds: Type.Optional(
		Type.Number({ description: `How long to wait before giving up (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` }),
	),
});

function registerTools(pi: ExtensionAPI, state: IntercomState): void {
	pi.registerTool({
		name: "intercom_send",
		label: "Intercom Send",
		description:
			"Send a message to another pi session over a named intercom channel. " +
			"Sessions in the same project directory sharing a channel name receive each other's messages.",
		promptSnippet: "Message another pi session on a named channel",
		promptGuidelines: [
			"Use intercom_send to talk to another pi session (answering its questions, coordinating work); after sending a question, call intercom_wait on the same channel for the reply.",
		],
		parameters: SEND_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const channel = normalizeChannel(params.channel);
			// Throwing is pi's error contract for tools: it sets isError on the result.
			if (!channel) throw new Error(`Invalid channel name: ${params.channel}`);
			const alias = params.alias?.trim();
			if (alias && !isValidAlias(alias)) {
				throw new Error("Invalid alias: use up to 32 characters of letters, digits, spaces, '_', '.', '-'.");
			}
			const entry = join(state, channel, alias || undefined);
			const message: IntercomMessage = {
				schema: INTERCOM_SCHEMA,
				channel,
				sender: ctx.sessionManager.getSessionId(),
				created: new Date().toISOString(),
				text: params.message,
			};
			if (entry.alias) message.alias = entry.alias;
			const path = writeMessage(ctx.cwd, message, state.seq++);
			return {
				content: [{ type: "text", text: `Sent to #${channel} (${path}).` }],
				details: { channel, path },
			};
		},
	});

	pi.registerTool({
		name: "intercom_wait",
		label: "Intercom Wait",
		description:
			"Wait for new intercom messages from other pi sessions on a channel. " +
			"Blocks until a message arrives or the timeout passes. Joining a channel delivers its existing backlog immediately.",
		promptSnippet: "Wait for a message from another pi session",
		promptGuidelines: [
			"Use intercom_wait when expecting a reply or instruction from another session; prefer one long wait over many short ones.",
		],
		parameters: WAIT_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const channel = normalizeChannel(params.channel);
			if (!channel) throw new Error(`Invalid channel name: ${params.channel}`);
			const timeoutS = Math.min(Math.max(params.timeout_seconds ?? WAIT_DEFAULT_S, 1), WAIT_MAX_S);
			const sessionId = ctx.sessionManager.getSessionId();
			const entry = join(state, channel);
			entry.waiting = true;
			try {
				const deadline = Date.now() + timeoutS * 1000;
				for (;;) {
					const collected = collectNew(ctx.cwd, channel, entry.seen, sessionId);
					for (const name of collected.skipped) entry.seen.add(name);
					if (collected.delivered.length > 0) {
						// The return value *is* the delivery, so marking seen here is safe.
						for (const item of collected.delivered) entry.seen.add(item.name);
						return {
							content: [
								{
									type: "text",
									text: formatIncoming(
										channel,
										collected.delivered.map((item) => item.message),
										newBatchId(),
									),
								},
							],
							// deliveredCount, not raw length: the text renders at most that many.
							details: { channel, count: deliveredCount(collected.delivered.length) },
						};
					}
					if (signal?.aborted) throw new Error("Wait cancelled.");
					if (Date.now() >= deadline) {
						return {
							content: [
								{ type: "text", text: `No messages on #${channel} within ${timeoutS}s. Still joined; the watcher will deliver anything that arrives later.` },
							],
							details: { channel, count: 0 },
						};
					}
					await sleep(Math.min(WAIT_POLL_MS, deadline - Date.now()), signal);
				}
			} finally {
				entry.waiting = false;
			}
		},
	});
}

const USAGE = "Usage: /intercom join <channel> [as <alias>] | leave <channel> | clear <channel> | status";

function registerIntercomCommand(pi: ExtensionAPI, state: IntercomState): void {
	pi.registerCommand("intercom", {
		description: "Session-to-session messaging: /intercom join <channel> [as <alias>] | leave | clear | status",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [verb, rawChannel] = parts;

			if (verb === "status") {
				const joined = [...state.joined.entries()]
					.map(([name, entry]) => `#${name}${entry.alias ? ` as ${entry.alias}` : ""}`)
					.join(", ");
				const onDisk = listChannels(ctx.cwd)
					.map((name) => `#${name} (${listMessageFiles(ctx.cwd, name).length})`)
					.join(", ");
				const lines = [
					`Joined: ${joined || "none"}`,
					`On disk: ${onDisk || "none"}`,
					...(state.watchError ? [`Watcher error: ${state.watchError}`] : []),
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!verb || !rawChannel) {
				ctx.ui.notify(USAGE, "error");
				return;
			}
			const channel = normalizeChannel(rawChannel);
			if (!channel) {
				ctx.ui.notify(`Invalid channel name: ${rawChannel}`, "error");
				return;
			}

			switch (verb) {
				case "join": {
					// `/intercom join dev as laptop-player`
					const alias = parts[2] === "as" ? parts.slice(3).join(" ") : undefined;
					if (alias && !isValidAlias(alias)) {
						ctx.ui.notify("Invalid alias: up to 32 chars of letters, digits, spaces, '_', '.', '-'.", "error");
						return;
					}
					join(state, channel, alias);
					ctx.ui.notify(
						`Joined #${channel}${alias ? ` as ${alias}` : ""}. Backlog and new messages will be delivered.`,
						"info",
					);
					return;
				}
				case "leave": {
					if (!state.joined.delete(channel)) {
						ctx.ui.notify(`Not joined to #${channel}`, "warning");
						return;
					}
					ctx.ui.notify(`Left #${channel}`, "info");
					return;
				}
				case "clear": {
					const removed = clearChannel(ctx.cwd, channel);
					// Forget seen names so the channel reads as brand new: the next scan
					// treats whatever arrives as a fresh backlog rather than a continuation.
					state.joined.get(channel)?.seen.clear();
					ctx.ui.notify(`Cleared #${channel} (${removed} message${removed === 1 ? "" : "s"} removed)`, "info");
					return;
				}
				default:
					ctx.ui.notify(USAGE, "error");
			}
		},
	});
}

/** Sets injected intercom traffic apart from the user's own prompts in the transcript. */
function registerIntercomRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("intercom", (message, { outputPad }, theme) => {
		const text = typeof message.content === "string" ? message.content : "";
		const [banner, ...rest] = text.split("\n");
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", banner)}\n${rest.join("\n")}`, 0, 0));
		return box;
	});
}

export default function (pi: ExtensionAPI) {
	const state: IntercomState = { joined: new Map(), seq: 0, agentActive: false };
	registerWatcher(pi, state);
	registerIntercomRenderer(pi);
	registerTools(pi, state);
	registerIntercomCommand(pi, state);
}
