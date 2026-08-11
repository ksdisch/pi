/**
 * Presentation for delivered intercom traffic. Pure string building, no I/O, so the
 * exact text the LLM sees is pinned by unit tests.
 */

import type { IntercomMessage } from "./store.ts";

/**
 * Delivery bounds. One injection lands whole in the receiving session's LLM context,
 * so a multi-day backlog (or one giant paste) must not become the first turn's
 * permanent prefix. The *newest* messages are kept — a joiner cares about where the
 * conversation is, not where it started; older history stays readable on disk.
 */
const MAX_MESSAGES = 50;
const PER_MESSAGE_CHARS = 2000;

export function senderLabel(message: IntercomMessage): string {
	// The uuidv7 *tail* is random bits; the head is a shared launch-time clock. See
	// `messageFilename` in store.ts for the failure the head would cause.
	const short = message.sender.slice(-8);
	return message.alias ? `${message.alias} (${short})` : short;
}

/**
 * The banner line is first and stands alone: the TUI renderer splits it off for
 * highlighting, mirroring the handoff memo's layout. The closing line bounds the
 * injection, so a message body cannot pose as further intercom traffic — bodies are
 * peer-written text and get no other fencing (peers are normally the same user's own
 * agents; DESIGN.md covers the trust boundary).
 */
export function formatIncoming(channel: string, messages: IntercomMessage[]): string {
	const kept = messages.slice(-MAX_MESSAGES);
	const omitted = messages.length - kept.length;

	const plural = kept.length === 1 ? "message" : "messages";
	const lines = [`Intercom #${channel} — ${kept.length} new ${plural}`];
	if (omitted > 0) {
		lines.push("", `(${omitted} older unread message${omitted === 1 ? "" : "s"} omitted; full history is in .pi/intercom/${channel}/)`);
	}
	for (const message of kept) {
		const text = message.text.trimEnd();
		const body = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text;
		lines.push("", `From ${senderLabel(message)} at ${message.created}:`, body);
	}
	lines.push("", `(end of intercom #${channel} traffic)`);
	return lines.join("\n");
}
