/**
 * Session Handoff extension.
 *
 * Every session leaves a durable handoff note in `<cwd>/.pi/handoffs/`, and new
 * sessions pick the newest pending note up as a first-message briefing. See DESIGN.md.
 *
 * Two writers:
 * - `/handoff [goal]` — rich, LLM-composed (slice 3).
 * - `session_shutdown` on quit — mechanical digest, no LLM. The seatbelt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDigestNote } from "./digest.ts";
import { writeNote } from "./notes.ts";
import { registerReader } from "./reader.ts";

export interface HandoffState {
	/** Set by `/handoff`. Suppresses the shutdown digest, which would supersede a richer note. */
	wroteNoteThisSession: boolean;
}

function modelLabel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function registerShutdownDigest(pi: ExtensionAPI, state: HandoffState): void {
	pi.on("session_shutdown", (event, ctx) => {
		// The event also fires for reload/new/resume/fork, which must not each drop a note.
		if (event.reason !== "quit") return;
		if (state.wroteNoteThisSession) return;

		// Undefined for `--no-session` runs: the user asked not to be recorded, so honor it.
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		try {
			const note = buildDigestNote({
				entries: ctx.sessionManager.getEntries(),
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
				cwd: ctx.cwd,
				model: modelLabel(ctx),
				created: new Date().toISOString(),
			});
			if (!note) return;

			const notePath = writeNote(ctx.cwd, note);
			if (ctx.hasUI) ctx.ui.notify(`Handoff note written: ${notePath}`, "info");
		} catch (err) {
			// Never let a note failure interfere with pi's exit.
			if (ctx.hasUI)
				ctx.ui.notify(`Handoff note failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	});
}

export default function (pi: ExtensionAPI) {
	const state: HandoffState = { wroteNoteThisSession: false };
	registerReader(pi);
	registerShutdownDigest(pi, state);
}
