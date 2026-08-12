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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type HandoffNote, listArchivedNotePathsForSession, readNote } from "./notes.ts";

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

/** Was this note written by `sessionId` and then ingested by someone? */
export function isConsumedNote(note: HandoffNote, sessionId: string): boolean {
	return note.frontmatter.session_id === sessionId && (note.frontmatter.consumed_by ?? "") !== "";
}

export interface ConsumedNote {
	path: string;
	note: HandoffNote;
}

/**
 * The newest archived note this session wrote that carries a `consumed_by` stamp.
 *
 * Newest, because a session can hand off more than once; the last one is the handoff that
 * actually ended its work.
 */
export function findConsumedNote(cwd: string, sessionId: string): ConsumedNote | undefined {
	const paths = listArchivedNotePathsForSession(cwd, sessionId);
	for (let i = paths.length - 1; i >= 0; i--) {
		const note = readNote(paths[i]);
		if (note && isConsumedNote(note, sessionId)) return { path: paths[i], note };
	}
	return undefined;
}

export interface RetireDeps {
	/**
	 * True once this session wrote a handoff note. Only such a session can have a note to be
	 * consumed, so this gates the scan: sessions that never hand off do no filesystem work.
	 */
	noteWritten: () => boolean;
	/** Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	// Headless modes have no notification surface; stderr keeps `-p` stdout clean.
	else console.error(message);
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

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function tick(): void {
		if (!ctx || reported || !deps.noteWritten()) return;
		try {
			const consumed = findConsumedNote(ctx.cwd, ctx.sessionManager.getSessionId());
			if (!consumed) return;
			reported = true;
			stop();
			const by = (consumed.note.frontmatter.consumed_by ?? "").slice(0, 8);
			report(ctx, `Handoff consumed by session ${by}; this session can retire.`, "info");
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
