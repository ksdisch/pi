/**
 * Context-fullness watcher: notice that the session is running out of room, and get a
 * handoff note written at the high-water mark rather than at the exit.
 *
 * Why that is worth having, precisely — the shutdown digest does *not* lose pre-compaction
 * history (it reads `getBranch()`, the full root-to-leaf path; see index.ts), so "compaction
 * ate the history" is not the reason:
 *
 * - The shutdown digest is best-effort. A crash, a SIGKILL, or a closed terminal never
 *   reaches `session_shutdown`, and a session near the end of its window is exactly where
 *   those happen. This note is already on disk by then.
 * - Compaction degrades the *session's own* working context. Once it has run, the moment to
 *   hand off has passed; the successor inherits a summary of a summary.
 * - It is the stopping-point detection an autonomous spawner needs.
 *
 * Two triggers, because one is not enough: `agent_settled`, and `session_before_compact` —
 * pi compacts *inside* the agent run, before settle, so a run that crosses the threshold and
 * trips the compaction trigger in one go would otherwise settle at `percent: null` and skip
 * the very crossing this exists to catch.
 *
 * pi imports are type-only, so this module is importable from tests (see DESIGN.md's
 * note on why `index.ts` is not).
 */

import type {
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildDigestNote, formatContextPercent } from "./digest.ts";
import { type HandoffNote, writeNote } from "./notes.ts";

export type WatchMode = "off" | "notify" | "propose" | "auto" | "spawn";

const MODES: WatchMode[] = ["off", "notify", "propose", "auto", "spawn"];

/**
 * `auto`, not `propose`. A dialog is the intrusive option everywhere it can appear: pi's
 * selector is not an overlay, so it disposes whatever selector was already open and takes
 * focus; the settle path awaits it, so a quit requested during the run waits behind it; and
 * in a scripted TUI the next `Enter` confirms the highlighted row instead of submitting the
 * user's prompt. Writing the note costs one file in a git-excluded directory and seizes
 * nothing, so that is what happens by default. `propose` remains available by env.
 */
export const DEFAULT_MODE: WatchMode = "auto";
export const DEFAULT_THRESHOLD_PERCENT = 80;

/**
 * Ceiling on how long the opt-in `propose` dialog may hold the settle path open. `emit`
 * awaits event handlers, so an unanswered dialog would otherwise park `agent_settled` — and
 * with it the shutdown check that services a quit pressed during the run — indefinitely.
 * A timed-out dialog resolves undefined, which is read as "not now".
 */
export const PROPOSE_TIMEOUT_MS = 30_000;

/**
 * How far usage must fall below the threshold before the watcher will fire again.
 * Re-arming at the threshold itself would re-propose on every settle while usage hovers
 * there; a compaction drops it far further than this, which is the crossing worth catching.
 */
export const REARM_MARGIN_PERCENT = 10;

export const MODE_ENV = "PI_HANDOFF_WATCH";
export const THRESHOLD_ENV = "PI_HANDOFF_WATCH_AT";
export const SPAWN_MAX_ENV = "PI_HANDOFF_SPAWN_MAX";

/**
 * Ceiling on successor spawns per process, across every session in the chain.
 *
 * A backstop, not a governor: each spawn needs a genuine threshold crossing, so reaching
 * ten means something is wrong — a threshold set below the re-arm margin, a successor that
 * inherits a full context, a loop nobody intended. Past the cap the watcher degrades to
 * `auto` (write the note, say why) rather than going quiet.
 */
export const DEFAULT_SPAWN_MAX = 10;

/**
 * Spawns performed by this *process*, not this session. Successor sessions replace the
 * extension instance but not the module, so a module-level counter is what survives the
 * chain it is counting — instance state resets on every `newSession` and would never reach
 * any cap.
 */
let spawnGeneration = 0;

/** Test-only: the chain counter is module state, so a test that spawns must reset it. */
export function resetSpawnGeneration(): void {
	spawnGeneration = 0;
}

export interface WatchConfig {
	mode: WatchMode;
	thresholdPercent: number;
	spawnMax: number;
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

	let spawnMax = DEFAULT_SPAWN_MAX;
	const rawSpawnMax = env[SPAWN_MAX_ENV]?.trim();
	if (rawSpawnMax) {
		const parsed = Number(rawSpawnMax);
		// Zero is a legitimate setting — "never spawn, just write the note" — so the floor is
		// zero, not one. Fractions and negatives are mistakes.
		if (!Number.isInteger(parsed) || parsed < 0) {
			warnings.push(`${SPAWN_MAX_ENV}="${rawSpawnMax}" is not a non-negative integer; using ${spawnMax}.`);
		} else {
			spawnMax = parsed;
		}
	}

	return { config: { mode, thresholdPercent, spawnMax }, warnings };
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
	/** Defaults to `process.pid`. Recorded in watch notes so readers can test writer liveness. */
	pid?: number;
	/**
	 * Compose a richer note body with one LLM call, for `spawn` mode. Injected rather than
	 * called directly: composing needs pi's runtime serializers, and this module's pi imports
	 * stay type-only so both halves of it can be unit-tested.
	 *
	 * Absent, returning undefined, or throwing all mean the same thing — write the mechanical
	 * note instead. A thin note plus `ask_predecessor` beats no successor at all, and the free
	 * tier throttles often enough that this is a normal outcome, not an exceptional one.
	 */
	composeNote?: (ctx: ExtensionContext) => Promise<{ body: string; kickoff?: string } | undefined>;
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

/**
 * Write the same mechanical digest the shutdown path writes, stamped as a watch note.
 *
 * `entries` is passed on the compaction path, where the event hands over the pre-compaction
 * branch directly; elsewhere it is the session's current branch.
 */
function buildWatchNote(
	ctx: ExtensionContext,
	percent: number,
	now: () => string,
	entries: SessionEntry[] | undefined,
	pid: number,
): HandoffNote | undefined {
	// Undefined for `--no-session` runs. The shutdown digest skips those to honor the
	// request not to be recorded; a note pointing at a transcript that will never exist
	// would be worse than none, so this skips too — loudly, since the user asked for one.
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		report(ctx, `${headline(percent)}, but this session is not recorded (--no-session); no note written.`, "warning");
		return undefined;
	}

	const note = buildDigestNote({
		// Same branch-not-entries reasoning as the shutdown digest; see index.ts.
		entries: entries ?? ctx.sessionManager.getBranch(),
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile,
		cwd: ctx.cwd,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		created: now(),
		trigger: "watch",
		contextPercent: percent,
	});
	if (!note) return undefined;

	// The writer of a watch note is, unlike every other note's writer, usually still running.
	// Recording its pid lets the reader tell a live snapshot from a dead session's seatbelt.
	note.frontmatter.pid = String(pid);
	return note;
}

/**
 * Replace this session with a successor and hand it the note's kickoff.
 *
 * The kickoff is submitted from inside `withSession`, against the *replacement* context: the
 * reader queued the briefing memo at `session_start`, and that memo is delivered by the first
 * real prompt, so briefing and marching orders land in the same turn. This is the `kickoff`
 * frontmatter field finally doing the job it was stored for.
 *
 * Nothing is reported after a successful spawn. The context this ran on belongs to the session
 * that no longer exists, and every member of it throws once the runner is stale — so the
 * announcement happens before, and only cancellation (which leaves the session intact) reports
 * after.
 */
async function spawnSuccessor(ctx: ExtensionContext, kickoff: string): Promise<void> {
	spawnGeneration++;
	const result = await ctx.newSession({
		withSession: async (replacementCtx) => {
			await replacementCtx.sendUserMessage(kickoff);
		},
	});
	if (result.cancelled) report(ctx, "Successor session was cancelled; the handoff note is still on disk.", "warning");
}

/**
 * Hand the successor spawn back to `/handoff`.
 *
 * Not because the watcher can't — `spawn` mode above does exactly that — but because this is
 * `propose`, and a user who is answering a dialog asked to review the note, not to have their
 * session replaced out from under them. `/handoff` composes a richer note and confirms the
 * spawn, so prefill it rather than reimplement half of it. Only into an empty editor:
 * overwriting what the user typed to save them a keystroke is not a trade worth making.
 */
function offerCompose(ctx: ExtensionContext): void {
	if (ctx.ui.getEditorText().trim() === "") {
		ctx.ui.setEditorText("/handoff");
		ctx.ui.notify("Prefilled /handoff — press enter to compose the note and start the successor.", "info");
	} else {
		ctx.ui.notify("Run /handoff to compose the note and start the successor.", "info");
	}
}

interface ActOptions {
	config: WatchConfig;
	percent: number;
	now: () => string;
	pid: number;
	deps: WatcherDeps;
	/**
	 * False on the compaction trigger. Compaction is already waiting on this handler, and a
	 * modal that pauses it is worse than one that pauses a finished run — so that path always
	 * writes rather than asks, whatever `propose` would have done.
	 */
	allowDialog: boolean;
	/** Pre-compaction branch, handed over by the compaction event. */
	entries?: SessionEntry[];
}

/** Returns the kickoff to spawn with, or undefined when this crossing must not spawn. */
async function act(ctx: ExtensionContext, options: ActOptions): Promise<string | undefined> {
	const { config, percent, now, pid, deps, allowDialog, entries } = options;
	if (config.mode === "notify") {
		report(ctx, `${headline(percent)}. Run /handoff to write a note for the next session.`, "info");
		return;
	}

	// A proposal needs a dialog that is safe to await. Outside the TUI there is none: an RPC
	// host may never answer, and `-p`/JSON have no dialog surface at all. The fallback is
	// `auto` rather than silence — the note is the point, and it costs nothing but a file.
	if (config.mode === "propose" && ctx.mode === "tui" && allowDialog) {
		const choice = await ctx.ui.select(headline(percent), [CHOICE_WRITE, CHOICE_COMPOSE, CHOICE_LATER], {
			timeout: PROPOSE_TIMEOUT_MS,
		});
		// Dismissed, or timed out unanswered: a "not now", not a reason to write anyway.
		if (choice === undefined || choice === CHOICE_LATER) return;
		if (choice === CHOICE_COMPOSE) {
			offerCompose(ctx);
			return;
		}
	}

	// Whether a successor is coming at all — asked before the note is written, because the
	// answer decides whether the body is worth an LLM call.
	const spawning = config.mode === "spawn" && spawnRefusal(ctx, config) === undefined;

	const note = buildWatchNote(ctx, percent, now, entries, pid);
	if (!note) return;

	// Composed only when a successor will actually read it. The call costs a request against
	// a free tier that allows ~20 a day, and `auto`'s note is read by a human who has the
	// session in front of them.
	if (spawning && deps.composeNote) {
		try {
			const composed = await deps.composeNote(ctx);
			if (composed) {
				note.body = composed.body;
				if (composed.kickoff) note.frontmatter.kickoff = composed.kickoff;
			} else {
				// Not an error — no model, or nothing to summarize — but the successor is getting
				// a thinner note than the mode advertises, so it is said out loud either way.
				report(ctx, "Nothing to compose from; spawning with the mechanical note.", "info");
			}
		} catch (err) {
			// A throttled or oversized compose must not cost the successor: the mechanical note
			// plus `ask_predecessor` still gets it working. This is the reporting path for a
			// provider refusal — see `composeForSpawn`, which throws to reach it.
			const why = describeError(err);
			report(ctx, `Handoff composition failed (${why}); spawning with the mechanical note.`, "warning");
		}
	}

	report(ctx, `${headline(percent)} — handoff note written: ${writeNote(ctx.cwd, note)}`, "info");
	// The caller decides *when*: now on a settle, or carried to the settle that follows a
	// compaction. Deferral is not refusal, so it is not consulted here.
	if (config.mode !== "spawn") return;
	return note.frontmatter.kickoff || "Continue the previous session's work.";
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Why a spawn must not happen right now, or undefined if it may. Re-read at the moment of
 * spawning rather than cached, so a crossing deferred by a compaction is judged on the state
 * it actually spawns in.
 */
function spawnRefusal(ctx: ExtensionContext, config: WatchConfig): string | undefined {
	// Queued follow-ups mean the session is not done, whatever the context gauge says.
	if (ctx.hasPendingMessages()) {
		return "Successor not started: this session still has queued messages. The handoff note is on disk.";
	}
	if (spawnGeneration >= config.spawnMax) {
		return (
			`Successor not started: ${spawnGeneration} spawns already in this process ` +
			`(${SPAWN_MAX_ENV}=${config.spawnMax}). The handoff note is on disk.`
		);
	}
	return undefined;
}

/**
 * Watch context usage, on every settled agent run and immediately before every compaction.
 *
 * Deliberately does not set `wroteNoteThisSession`: the session usually keeps working after
 * this fires, so the shutdown digest — written later, from more history — should still run.
 * Both notes end up pending and the reader ingests the newer one, superseding this.
 */
export function registerWatcher(pi: ExtensionAPI, deps: WatcherDeps): void {
	const { config, warnings } = readWatchConfig(deps.env ?? process.env);
	const now = deps.now ?? (() => new Date().toISOString());
	const pid = deps.pid ?? process.pid;
	let armed = true;
	let reportedWarnings = false;
	/** An act is in flight. A dialog can be open across several settles; never stack two. */
	let busy = false;
	/**
	 * A spawn the compaction path wrote a note for and deferred. The compaction trigger runs
	 * *inside* the agent run, and spawning there does not merely risk stale contexts — it
	 * hangs pi. Replacing a session aborts the old one and waits for it to go idle, and the
	 * run cannot go idle until this handler returns, so the two wait on each other forever
	 * (`newSession`'s own doc in `extensions/types.ts` names the deadlock).
	 * `_emitAgentSettled` runs in the loop's `finally`, so a settle always follows; the spawn
	 * rides to it, where the run is over and both problems are gone.
	 */
	let pendingSpawn: string | undefined;

	async function spawn(ctx: ExtensionContext, kickoff: string): Promise<void> {
		const refusal = spawnRefusal(ctx, config);
		if (refusal !== undefined) {
			report(ctx, refusal, "warning");
			return;
		}
		report(ctx, "Context is full — starting a successor session and handing it the note.", "info");
		await spawnSuccessor(ctx, kickoff);
	}

	async function check(ctx: ExtensionContext, allowDialog: boolean, entries?: SessionEntry[]): Promise<void> {
		if (config.mode === "off" || busy) return;
		// `/handoff` wrote a richer note; a mechanical one now would supersede it as "newest".
		if (deps.handoffWritten()) return;

		const evaluation = evaluateWatch(ctx.getContextUsage(), config, armed);
		armed = evaluation.armed;
		if (!evaluation.act || evaluation.percent === undefined) return;

		busy = true;
		try {
			const kickoff = await act(ctx, {
				config,
				percent: evaluation.percent,
				now,
				pid,
				deps,
				allowDialog,
				entries,
			});
			if (kickoff === undefined) return;
			// `allowDialog` is false on exactly one path — the compaction trigger — which is also
			// the one path that must not spawn in place. One flag, both meanings.
			if (allowDialog) await spawn(ctx, kickoff);
			else pendingSpawn = kickoff;
		} catch (err) {
			report(ctx, `Handoff watcher failed: ${describeError(err)}`, "warning");
		} finally {
			busy = false;
		}
	}

	pi.on("agent_settled", async (_event, ctx) => {
		if (!reportedWarnings) {
			reportedWarnings = true;
			for (const warning of warnings) report(ctx, warning, "warning");
		}
		// Before the usage check, not after: the crossing already happened, and post-compaction
		// usage reads as `null` anyway, so a fresh evaluation would decide nothing.
		if (pendingSpawn !== undefined) {
			const kickoff = pendingSpawn;
			pendingSpawn = undefined;
			try {
				await spawn(ctx, kickoff);
			} catch (err) {
				report(ctx, `Handoff successor failed: ${describeError(err)}`, "warning");
			}
			return;
		}
		await check(ctx, true);
	});

	// pi compacts inside the agent run, before `agent_settled`: `_checkCompaction` is called
	// from `_handlePostAgentRun`, and `_emitAgentSettled` only runs in the `finally` after that
	// loop. So a run that goes from under the threshold to over the compaction trigger in one
	// step reaches settle with `percent: null` — pi cannot price the new context until the next
	// assistant reply — and the crossing this feature exists for would pass unnoticed. This is
	// the same crossing, caught one step earlier, with the pre-compaction branch in hand.
	pi.on("session_before_compact", async (event, ctx) => {
		await check(ctx, false, event.branchEntries);
		// Returns nothing on purpose: a truthy result here can cancel the compaction.
	});
}
