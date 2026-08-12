/**
 * Context-fullness watcher: notice that the session is running out of room, and get a
 * handoff note written while the history that note summarizes is still there.
 *
 * The shutdown digest fires at quit, which on a long session is after compaction has
 * already elided the middle of the work. This watcher fires earlier, on `agent_settled`,
 * off `ctx.getContextUsage()`.
 *
 * pi imports are type-only, so this module is importable from tests (see DESIGN.md's
 * note on why `index.ts` is not).
 */

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDigestNote, formatContextPercent } from "./digest.ts";
import { writeNote } from "./notes.ts";

export type WatchMode = "off" | "notify" | "propose" | "auto";

const MODES: WatchMode[] = ["off", "notify", "propose", "auto"];

export const DEFAULT_MODE: WatchMode = "propose";
export const DEFAULT_THRESHOLD_PERCENT = 80;

/**
 * How far usage must fall below the threshold before the watcher will fire again.
 * Re-arming at the threshold itself would re-propose on every settle while usage hovers
 * there; a compaction drops it far further than this, which is the crossing worth catching.
 */
export const REARM_MARGIN_PERCENT = 10;

export const MODE_ENV = "PI_HANDOFF_WATCH";
export const THRESHOLD_ENV = "PI_HANDOFF_WATCH_AT";

export interface WatchConfig {
	mode: WatchMode;
	thresholdPercent: number;
}

export interface WatchConfigResult {
	config: WatchConfig;
	/** Reported once, at the first settle. A typo'd env var must not fail silently. */
	warnings: string[];
}

function isWatchMode(value: string): value is WatchMode {
	return (MODES as string[]).includes(value);
}

/**
 * Read the watcher's settings from the environment.
 *
 * Environment rather than CLI flags because the successor sessions this is groundwork for
 * are spawned as child processes, which inherit env and not argv.
 */
export function readWatchConfig(env: Record<string, string | undefined>): WatchConfigResult {
	const warnings: string[] = [];

	let mode = DEFAULT_MODE;
	const rawMode = env[MODE_ENV]?.trim();
	if (rawMode) {
		const normalized = rawMode.toLowerCase();
		if (isWatchMode(normalized)) mode = normalized;
		else warnings.push(`${MODE_ENV}="${rawMode}" is not one of ${MODES.join(", ")}; using "${mode}".`);
	}

	let thresholdPercent = DEFAULT_THRESHOLD_PERCENT;
	const rawThreshold = env[THRESHOLD_ENV]?.trim();
	if (rawThreshold) {
		const parsed = Number(rawThreshold);
		// A threshold outside (0, 100] is not a preference, it is a mistake: 0 or less fires
		// on an empty session, above 100 can never fire at all.
		if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
			warnings.push(`${THRESHOLD_ENV}="${rawThreshold}" is not a percent in (0, 100]; using ${thresholdPercent}.`);
		} else {
			thresholdPercent = parsed;
		}
	}

	return { config: { mode, thresholdPercent }, warnings };
}

export interface WatchEvaluation {
	/** Fire the watcher now. */
	act: boolean;
	/** Armed state to carry into the next settle. */
	armed: boolean;
	/** Usage that triggered the firing. Only set when `act`. */
	percent?: number;
}

/**
 * Decide whether this settle crosses the threshold, given whether the watcher is armed.
 * Pure: the caller owns the armed flag and the side effects.
 */
export function evaluateWatch(usage: ContextUsage | undefined, config: WatchConfig, armed: boolean): WatchEvaluation {
	if (config.mode === "off") return { act: false, armed };

	// `percent` is null between a compaction and the next assistant response, which is when
	// pi cannot yet price the new context. Unknown is not "low": leave the flag as it is.
	const percent = usage?.percent;
	if (percent === undefined || percent === null) return { act: false, armed };

	if (percent < config.thresholdPercent) {
		return { act: false, armed: armed || percent <= config.thresholdPercent - REARM_MARGIN_PERCENT };
	}
	if (!armed) return { act: false, armed };
	return { act: true, armed: false, percent };
}

export interface WatcherDeps {
	/** True once `/handoff` composed a note this session. */
	handoffWritten: () => boolean;
	/** Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/**
	 * ISO timestamp source, defaulting to the wall clock. Injected in tests, where two notes
	 * can otherwise land in the same millisecond — and the filename is built from that
	 * timestamp plus the session id, so they would collide.
	 */
	now?: () => string;
}

const CHOICE_WRITE = "Write a handoff note now";
const CHOICE_COMPOSE = "Compose with /handoff (richer, can start the successor)";
const CHOICE_LATER = "Not now";

function report(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	// Headless modes have no notification surface; stderr keeps `-p` stdout clean.
	else console.error(message);
}

function headline(percent: number): string {
	return `Context is ${formatContextPercent(percent)}% full`;
}

/** Write the same mechanical digest the shutdown path writes, stamped as a watch note. */
function writeWatchNote(ctx: ExtensionContext, percent: number, now: () => string): void {
	// Undefined for `--no-session` runs. The shutdown digest skips those to honor the
	// request not to be recorded; a note pointing at a transcript that will never exist
	// would be worse than none, so this skips too — loudly, since the user asked for one.
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		report(ctx, `${headline(percent)}, but this session is not recorded (--no-session); no note written.`, "warning");
		return;
	}

	const note = buildDigestNote({
		// Same branch-not-entries reasoning as the shutdown digest; see index.ts.
		entries: ctx.sessionManager.getBranch(),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile,
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		created: now(),
		trigger: "watch",
		contextPercent: percent,
	});
	if (!note) return;

	report(ctx, `${headline(percent)} — handoff note written: ${writeNote(ctx.cwd, note)}`, "info");
}

/**
 * Hand the successor spawn back to `/handoff`.
 *
 * The watcher cannot spawn one itself: `newSession()` lives on `ExtensionCommandContext`,
 * and event handlers are given the plain `ExtensionContext` (runner.ts `createContext` vs
 * `createCommandContext`). `/handoff` has the command context, already composes a richer
 * note, and already confirms the spawn — so prefill it rather than reimplement half of it.
 * Only into an empty editor: overwriting what the user typed to save them a keystroke is
 * not a trade worth making.
 */
function offerCompose(ctx: ExtensionContext): void {
	if (ctx.ui.getEditorText().trim() === "") {
		ctx.ui.setEditorText("/handoff");
		ctx.ui.notify("Prefilled /handoff — press enter to compose the note and start the successor.", "info");
	} else {
		ctx.ui.notify("Run /handoff to compose the note and start the successor.", "info");
	}
}

async function act(ctx: ExtensionContext, config: WatchConfig, percent: number, now: () => string): Promise<void> {
	if (config.mode === "notify") {
		report(ctx, `${headline(percent)}. Run /handoff to write a note for the next session.`, "info");
		return;
	}

	// A proposal needs a dialog that is safe to await. Outside the TUI there is none: an RPC
	// host may never answer, and `-p`/JSON have no dialog surface at all. The fallback is
	// `auto` rather than silence — the note is the point, and it costs nothing but a file.
	if (config.mode === "propose" && ctx.mode === "tui") {
		const choice = await ctx.ui.select(headline(percent), [CHOICE_WRITE, CHOICE_COMPOSE, CHOICE_LATER]);
		// Dismissing the dialog is a "not now", not a reason to write anyway.
		if (choice === undefined || choice === CHOICE_LATER) return;
		if (choice === CHOICE_COMPOSE) {
			offerCompose(ctx);
			return;
		}
	}

	writeWatchNote(ctx, percent, now);
}

/**
 * Watch context usage on every settled agent run.
 *
 * Deliberately does not set `wroteNoteThisSession`: the session usually keeps working after
 * this fires, so the shutdown digest — written later, from more history — should still run.
 * Both notes end up pending and the reader ingests the newer one, superseding this.
 */
export function registerWatcher(pi: ExtensionAPI, deps: WatcherDeps): void {
	const { config, warnings } = readWatchConfig(deps.env ?? process.env);
	const now = deps.now ?? (() => new Date().toISOString());
	let armed = true;
	let reportedWarnings = false;
	/** A proposal is open. A run queued behind the dialog must not stack a second one. */
	let busy = false;

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reportedWarnings) {
			reportedWarnings = true;
			for (const warning of warnings) report(ctx, warning, "warning");
		}
		if (config.mode === "off" || busy) return;
		// `/handoff` wrote a richer note; a mechanical one now would supersede it as "newest".
		if (deps.handoffWritten()) return;

		const evaluation = evaluateWatch(ctx.getContextUsage(), config, armed);
		armed = evaluation.armed;
		if (!evaluation.act || evaluation.percent === undefined) return;

		busy = true;
		try {
			await act(ctx, config, evaluation.percent, now);
		} catch (err) {
			report(ctx, `Handoff watcher failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		} finally {
			busy = false;
		}
	});
}
