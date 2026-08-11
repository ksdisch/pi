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

/** How many messages one injection can carry; exported so callers report it honestly. */
export function deliveredCount(total: number): number {
	return Math.min(total, MAX_MESSAGES);
}

/**
 * The banner line is first and stands alone: the TUI renderer splits it off for
 * highlighting, mirroring the handoff memo's layout.
 *
 * `batchId` is a caller-generated nonce carried by both the banner and the closing
 * fence. Bodies are peer-written text interpolated verbatim, so a body could
 * reproduce a *static* closing line and forge messages after it — but it cannot
 * predict the nonce, so the matching-fence line is the one true end of the batch.
 * Forged `From …:` blocks *inside* a batch remain possible; that residual is
 * DESIGN.md's documented trust boundary, not something a format can fix.
 */
export function formatIncoming(channel: string, messages: IntercomMessage[], batchId: string): string {
	const kept = messages.slice(-MAX_MESSAGES);
	const omitted = messages.length - kept.length;

	const plural = kept.length === 1 ? "message" : "messages";
	const lines = [`Intercom #${channel} — ${kept.length} new ${plural} [batch ${batchId}]`];
	if (omitted > 0) {
		lines.push("", `(${omitted} older unread message${omitted === 1 ? "" : "s"} omitted; full history is in .pi/intercom/${channel}/)`);
	}
	for (const message of kept) {
		const text = message.text.trimEnd();
		const body = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text;
		lines.push("", `From ${senderLabel(message)} at ${message.created}:`, body);
	}
	lines.push("", `(end of intercom #${channel} traffic [batch ${batchId}])`);
	return lines.join("\n");
}
