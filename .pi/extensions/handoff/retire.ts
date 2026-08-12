/**
 * Retirement: a session whose handoff note was picked up elsewhere notices, and can shut
 * itself down.
 *
 * The problem is the desktop, not the process. A session that ran `/handoff` and had its
 * note ingested by another window has nothing left to do, but it keeps its terminal window
 * open forever — nobody tells it the work moved on. So it asks: is one of *my* notes sitting
 * in `archive/` with a `consumed_by` stamp on it?
 *
 * `superseded_by` deliberately does not qualify. Superseded means a newer note won the
 * briefing slot, not that this session's work was ingested by anyone.
 *
 * A consequence worth stating: watch notes cannot drive this. The reader's liveness guard
 * makes sibling processes skip a live writer's watch note, so one can never be stamped
 * `consumed_by` while its writer is alive to react. In practice the predicate fires for
 * `/handoff`-written notes — the deliberate cross-process handoff — which is the right
 * shape: retirement follows an intentional handoff, not a mid-session snapshot.
 *
 * pi imports are type-only, so this module is importable from tests (see DESIGN.md's note
 * on why `index.ts` is not).
 */

import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { archiveDir, type HandoffNote, readNote } from "./notes.ts";

export type RetireMode = "off" | "notify" | "auto";

const MODES: RetireMode[] = ["off", "notify", "auto"];

/**
 * `notify` — telling the user their session is redundant costs nothing; ending it without
 * being asked to is the kind of thing that has to be opted into. `auto` is the same
 * detection with the exit attached.
 */
export const DEFAULT_MODE: RetireMode = "notify";

export const MODE_ENV = "PI_HANDOFF_RETIRE";

/**
 * Poll interval. The event stream cannot carry this signal: the note is consumed by a
 * *different* process, and the session waiting to hear about it is by definition idle, so
 * there is no event of ours left to piggyback on.
 */
export const POLL_MS = 30_000;

/**
 * How long `auto` waits between announcing the retirement and performing it.
 *
 * Not a formality: the announcement is the only warning anyone gets, and a session that
 * turns out to be mid-something during the wait keeps its life (see the guards at expiry).
 */
export const GRACE_MS = 30_000;

export interface RetireConfig {
	mode: RetireMode;
}

export interface RetireConfigResult {
	config: RetireConfig;
	/** Reported once, at session start. A typo'd env var must not fail silently. */
	warnings: string[];
}

function isRetireMode(value: string): value is RetireMode {
	return (MODES as string[]).includes(value);
}

/** Read retirement settings from the environment. Same parse-with-warn rules as the watcher. */
export function readRetireConfig(env: Record<string, string | undefined>): RetireConfigResult {
	const warnings: string[] = [];

	let mode = DEFAULT_MODE;
	const raw = env[MODE_ENV]?.trim();
	if (raw) {
		const normalized = raw.toLowerCase();
		if (isRetireMode(normalized)) mode = normalized;
		else warnings.push(`${MODE_ENV}="${raw}" is not one of ${MODES.join(", ")}; using "${mode}".`);
	}

	return { config: { mode }, warnings };
}

/**
 * Was this note written by `sessionId` and then ingested by *someone else*?
 *
 * "Someone else" is load-bearing. A session id outlives its process — `pi -c` resumes
 * through the id in the session-file header — so a session can meet its own note again
 * after a restart, and the reader ingests pending notes on `reason: "startup"` and stamps
 * them with the id of the session doing the reading. That stamp reads as "consumed" while
 * meaning "I picked up my own note", which is not a reason for anyone to retire.
 */
export function isConsumedNote(note: HandoffNote, sessionId: string): boolean {
	const consumedBy = note.frontmatter.consumed_by ?? "";
	return note.frontmatter.session_id === sessionId && consumedBy !== "" && consumedBy !== sessionId;
}

export interface ConsumedNote {
	path: string;
	note: HandoffNote;
}

/**
 * Has *this* note — the one `/handoff` wrote in this run — been archived as consumed?
 *
 * Identity is the note, not the session id. Matching on the id alone would match every note
 * the id ever wrote, including ones consumed in a previous life of the same session: a
 * resumed session that hands off would announce the *old* handoff, and under `auto` exit
 * while the note it just wrote sat unread. Archiving preserves the basename, so the note's
 * archived location is derivable from its pending one.
 */
export function findConsumedNote(cwd: string, notePath: string, sessionId: string): ConsumedNote | undefined {
	const archived = join(archiveDir(cwd), basename(notePath));
	const note = readNote(archived);
	return note && isConsumedNote(note, sessionId) ? { path: archived, note } : undefined;
}

export interface RetireDeps {
	/**
	 * Path of the note `/handoff` wrote this run, or undefined if it has not run. Only such a
	 * session has a note that can be consumed, so this gates the scan: sessions that never
	 * hand off do no filesystem work.
	 */
	handoffNotePath: () => string | undefined;
	/**
	 * Set the flag that stops the shutdown digest from writing. Without it, a retiring
	 * session's exit would drop a fresh pending note re-advertising work that was already
	 * picked up, and the next session would ingest its own predecessor's ghost.
	 */
	suppressShutdownDigest: () => void;
	/** Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	// Headless modes have no notification surface; stderr keeps `-p` stdout clean.
	else console.error(message);
}

/**
 * Did anything happen in this session after the note was written?
 *
 * A session that kept working after handing off has outgrown its note: the successor was
 * briefed on a stopping point this session then walked past, so exiting here would throw
 * away work nobody else has. An unreadable timestamp counts as activity — the guard's whole
 * job is to refuse in the dark.
 */
function hasActivitySince(ctx: ExtensionContext, created: string): boolean {
	const noteAt = Date.parse(created);
	if (!Number.isFinite(noteAt)) return true;
	const entries = ctx.sessionManager.getBranch();
	const last = entries[entries.length - 1];
	if (!last) return false;
	const lastAt = Date.parse(last.timestamp);
	return !Number.isFinite(lastAt) || lastAt > noteAt;
}

/**
 * Watch for this session's handoff being consumed elsewhere, and report it.
 *
 * The poll is armed at `session_start` and torn down at `session_shutdown` — which fires for
 * reload/new/resume/fork too, every path that replaces this extension instance, so a
 * replacement can never leak a live interval bound to a dead runtime (the intercom watcher's
 * discipline). It is `unref()`ed: a session waiting to be retired must never be the reason
 * pi cannot exit.
 */
export function registerRetire(pi: ExtensionAPI, deps: RetireDeps): void {
	const { config, warnings } = readRetireConfig(deps.env ?? process.env);
	let timer: ReturnType<typeof setInterval> | undefined;
	/**
	 * The context to act through, refreshed at every `session_start`. Contexts are lazy views
	 * over the runner rather than snapshots (runner.ts `createContext`), so holding one across
	 * ticks reads current state — and if the instance is torn down between the shutdown event
	 * and a pending tick, its guards throw, which `tick` catches.
	 */
	let ctx: ExtensionContext | undefined;
	/** The predicate stays true once it fires; report it once, then stop looking. */
	let reported = false;
	let grace: ReturnType<typeof setTimeout> | undefined;

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (grace) clearTimeout(grace);
		grace = undefined;
	}

	/**
	 * Perform the retirement, unless the session turned out to still be busy.
	 *
	 * All three guards are re-read here rather than at detection: the grace window exists
	 * precisely so that a session which comes back to life during it gets to keep living.
	 */
	function retire(note: HandoffNote): void {
		grace = undefined;
		if (!ctx) return;
		try {
			if (!ctx.isIdle() || ctx.hasPendingMessages() || hasActivitySince(ctx, note.frontmatter.created)) {
				report(ctx, "Handoff was consumed elsewhere, but this session is still working; staying up.", "info");
				return;
			}
			// Before shutdown, not after: `shutdown()` is what emits `session_shutdown`, and the
			// digest handler reads the flag synchronously from it.
			deps.suppressShutdownDigest();
			report(ctx, "Retiring: this session's handoff was consumed elsewhere.", "info");
			ctx.shutdown();
		} catch (err) {
			report(ctx, `Handoff retirement failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

	function tick(): void {
		const notePath = deps.handoffNotePath();
		if (!ctx || reported || !notePath) return;
		try {
			const consumed = findConsumedNote(ctx.cwd, notePath, ctx.sessionManager.getSessionId());
			if (!consumed) return;
			reported = true;
			stop();
			const by = (consumed.note.frontmatter.consumed_by ?? "").slice(0, 8);
			report(ctx, `Handoff consumed by session ${by}; this session can retire.`, "info");
			if (config.mode !== "auto") return;
			const note = consumed.note;
			grace = setTimeout(() => retire(note), GRACE_MS);
			grace.unref();
		} catch (err) {
			// A throwing interval callback is an unhandled exception, which would take pi down
			// over a bookkeeping poll. Report and stand down instead.
			stop();
			report(ctx, `Handoff retirement check failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

	pi.on("session_start", (_event, startCtx) => {
		// Every reason, including resume/fork: whatever session is live now is the identity and
		// cwd to watch.
		ctx = startCtx;
		if (timer) return;
		for (const warning of warnings) report(startCtx, warning, "warning");
		if (config.mode === "off") return;
		timer = setInterval(tick, POLL_MS);
		timer.unref();
	});

	pi.on("session_shutdown", () => {
		stop();
		ctx = undefined;
	});
}
