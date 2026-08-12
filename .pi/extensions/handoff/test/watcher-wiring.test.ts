import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSettledEvent,
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HandoffNote, listPendingNotePaths, readNote } from "../notes.ts";
import {
	MODE_ENV,
	PROPOSE_TIMEOUT_MS,
	registerWatcher,
	resetSpawnGeneration,
	SPAWN_MAX_ENV,
	THRESHOLD_ENV,
} from "../watcher.ts";

/** `propose` is opt-in since it is the only mode that can seize the TUI. */
const PROPOSE = { [MODE_ENV]: "propose" };

type Notification = { message: string; level: string | undefined };

interface HarnessOptions {
	env?: Record<string, string | undefined>;
	/** `ExtensionMode` is not re-exported from the package root, so spell it out. */
	mode?: "tui" | "rpc" | "json" | "print";
	/** Option picked from the proposal dialog, by index. Undefined = dismissed. */
	pick?: number;
	editorText?: string;
	sessionFile?: string | undefined;
	handoffWritten?: boolean;
	entries?: SessionEntry[];
	pid?: number;
	/** A successor session has its own id; notes are named from it, so collisions are real. */
	sessionId?: string;
	pendingMessages?: boolean;
	/** Result of the injected composer. A rejected promise stands in for a throttled provider. */
	compose?: () => Promise<{ body: string; kickoff?: string } | undefined>;
	/** `newSession` outcome. Cancelled means the session was never replaced. */
	newSessionCancelled?: boolean;
}

const ASSISTANT_TURN: SessionEntry[] = [
	{
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "2026-08-11T09:00:00.000Z",
		message: { role: "user", content: [{ type: "text", text: "Wire the watcher" }], timestamp: 0 },
	} as SessionEntry,
	{
		type: "message",
		id: "e2",
		parentId: "e1",
		timestamp: "2026-08-11T09:01:00.000Z",
		message: { role: "assistant", content: [{ type: "text", text: "Wired." }], timestamp: 0 },
	} as SessionEntry,
];

/**
 * Minimal stand-in for the parts of ExtensionAPI/ExtensionContext the watcher touches.
 * What these tests cover is the wiring: which mode does what, and what reaches disk.
 */
function harness(cwd: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: Notification[] = [];
	const dialogs: { title: string; options: string[]; timeout?: number }[] = [];
	let usage: ContextUsage | undefined;
	let editorText = options.editorText ?? "";

	const pi = {
		on: (event: string, registered: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;

	/** Kickoffs submitted by successor sessions, in order. */
	const spawns: string[] = [];

	const ctx = {
		cwd,
		hasUI: true,
		mode: options.mode ?? "tui",
		model: { provider: "google", id: "gemini-3.6-flash" },
		getContextUsage: () => usage,
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			select: async (title: string, choices: string[], opts?: { timeout?: number }) => {
				dialogs.push({ title, options: choices, timeout: opts?.timeout });
				return options.pick === undefined ? undefined : choices[options.pick];
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? "019fee63-writer",
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/sessions/019fee63.jsonl"),
			getBranch: () => options.entries ?? ASSISTANT_TURN,
		},
		hasPendingMessages: () => options.pendingMessages ?? false,
		newSession: async (opts?: { withSession?: (ctx: unknown) => Promise<void> }) => {
			if (options.newSessionCancelled) return { cancelled: true };
			// The replacement context is a fresh command context bound to the new session; only
			// sendUserMessage is exercised here, which is all the watcher uses it for.
			await opts?.withSession?.({
				sendUserMessage: async (content: string) => {
					spawns.push(content);
				},
			});
			return { cancelled: false };
		},
	} as unknown as ExtensionContext;

	let tick = 0;
	registerWatcher(pi, {
		handoffWritten: () => options.handoffWritten ?? false,
		composeNote: options.compose,
		env: options.env ?? {},
		// Fixed clock: two real writes can land in the same millisecond, and the filename is
		// the timestamp plus the session id, so they would silently overwrite each other.
		now: () => `2026-08-11T09:0${tick++}:00.000Z`,
		// A pid no live process can hold, so notes written here read as dead-writer notes.
		pid: options.pid ?? 99_999_999,
	});

	const setUsage = (percent: number | null) => {
		usage = { tokens: percent === null ? null : 160_000, contextWindow: 200_000, percent };
	};

	return {
		notifications,
		dialogs,
		spawns,
		editorText: () => editorText,
		settle: async (percent: number | null) => {
			setUsage(percent);
			await handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		},
		/** The compaction trigger, carrying the pre-compaction branch pi hands over. */
		beforeCompact: async (percent: number | null, entries: SessionEntry[] = ASSISTANT_TURN) => {
			setUsage(percent);
			return handlers.get("session_before_compact")?.({ type: "session_before_compact", branchEntries: entries }, ctx);
		},
		notes: (): HandoffNote[] => listPendingNotePaths(cwd).map((path) => readNote(path) as HandoffNote),
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-watcher-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("watcher wiring", () => {
	it("writes a watch-stamped note in auto mode", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" } });
		await h.settle(85);

		const notes = h.notes();
		expect(notes).toHaveLength(1);
		expect(notes[0].frontmatter.source).toBe("watch");
		expect(notes[0].frontmatter.session_file).toBe("/sessions/019fee63.jsonl");
		expect(notes[0].frontmatter.model).toBe("google/gemini-3.6-flash");
		// The body must not claim the session ended: it is still running.
		expect(notes[0].body).toContain("mid-session at 85% context usage");
		expect(notes[0].body).not.toContain("previous session exited");
		expect(h.dialogs).toHaveLength(0);
		expect(h.notifications[0].message).toContain("handoff note written");
	});

	// The default must not seize the TUI: pi's selector is not an overlay, so a modal here
	// disposes any open selector, blocks a quit requested during the run, and eats the next
	// scripted Enter. Writing the note costs a file and seizes nothing.
	it("writes without a dialog when nothing is configured, even in the TUI", async () => {
		const h = harness(dir);
		await h.settle(85);

		expect(h.dialogs).toHaveLength(0);
		expect(h.notes()).toHaveLength(1);
	});

	// Only watch notes carry it: their writer is usually still running, and a reader in the
	// same cwd needs to tell that from a dead session's seatbelt.
	it("records the writing process id", async () => {
		const h = harness(dir, { pid: 4242 });
		await h.settle(85);
		expect(h.notes()[0].frontmatter.pid).toBe("4242");
	});

	it("stays below the line without writing anything", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" } });
		await h.settle(79);
		expect(h.notes()).toHaveLength(0);
		expect(h.notifications).toHaveLength(0);
	});

	it("writes only once per crossing, then again after a compaction re-arms it", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" } });
		await h.settle(85);
		await h.settle(90);
		expect(h.notes()).toHaveLength(1);

		await h.settle(null); // compaction ran; usage not yet priced
		await h.settle(30); // re-armed
		await h.settle(88);
		expect(h.notes()).toHaveLength(2);
	});

	it("proposes in the TUI and writes when the note is chosen", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 0 });
		await h.settle(82);

		expect(h.dialogs).toHaveLength(1);
		expect(h.dialogs[0].title).toContain("82%");
		expect(h.notes()).toHaveLength(1);
	});

	// `emit` awaits the handler, so an unanswered dialog would park the settle path — and
	// with it the shutdown check that services a quit pressed during the run.
	it("bounds how long the proposal can hold the settle path open", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 0 });
		await h.settle(82);
		expect(h.dialogs[0].timeout).toBe(PROPOSE_TIMEOUT_MS);
	});

	it("writes nothing when the proposal is declined", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 2 });
		await h.settle(82);
		expect(h.notes()).toHaveLength(0);
	});

	it("treats a dismissed or timed-out dialog as a decline", async () => {
		const h = harness(dir, { env: PROPOSE, pick: undefined });
		await h.settle(82);
		expect(h.dialogs).toHaveLength(1);
		expect(h.notes()).toHaveLength(0);
	});

	// The watcher cannot spawn a successor itself (newSession is command-context-only), so
	// the compose choice hands that job to /handoff, which can.
	it("prefills /handoff into an empty editor when compose is chosen", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 1 });
		await h.settle(82);

		expect(h.dialogs[0].options[1]).toContain("/handoff");
		expect(h.editorText()).toBe("/handoff");
		expect(h.notes()).toHaveLength(0);
	});

	it("never overwrites text the user already typed", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 1, editorText: "half a prompt" });
		await h.settle(82);

		expect(h.editorText()).toBe("half a prompt");
		expect(h.notifications.at(-1)?.message).toContain("Run /handoff");
	});

	// A proposal nobody can answer loses the note, and an RPC host may never answer at all.
	it.each(["print", "rpc", "json"] as const)("writes without asking in %s mode", async (mode) => {
		const h = harness(dir, { env: PROPOSE, mode });
		await h.settle(82);

		expect(h.dialogs).toHaveLength(0);
		expect(h.notes()).toHaveLength(1);
	});

	// The headline case: pi compacts inside the agent run, before agent_settled. A run that
	// goes from under the threshold to over the compaction trigger in one step settles at
	// `percent: null`, so settle alone would miss exactly the crossing this exists for.
	it("catches a crossing that goes straight into compaction", async () => {
		const h = harness(dir);
		await h.settle(70);
		expect(h.notes()).toHaveLength(0);

		await h.beforeCompact(92);
		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].body).toContain("mid-session at 92% context usage");

		// The settle that follows the compaction must not write a second note.
		await h.settle(null);
		expect(h.notes()).toHaveLength(1);
	});

	it("digests the pre-compaction branch the event hands over, not the live one", async () => {
		const h = harness(dir, { entries: [] });
		await h.beforeCompact(92, [
			ASSISTANT_TURN[0],
			{
				type: "message",
				id: "e3",
				parentId: "e1",
				timestamp: "2026-08-11T09:02:00.000Z",
				message: { role: "assistant", content: [{ type: "text", text: "Pre-compaction reply." }], timestamp: 0 },
			} as SessionEntry,
		]);

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].body).toContain("Pre-compaction reply.");
	});

	// Compaction is already waiting on this handler; a modal that pauses it is worse than one
	// that pauses a finished run.
	it("never opens a dialog on the compaction path, even in propose mode", async () => {
		const h = harness(dir, { env: PROPOSE, pick: 2 });
		await h.beforeCompact(92);

		expect(h.dialogs).toHaveLength(0);
		expect(h.notes()).toHaveLength(1);
	});

	// A truthy result from this handler cancels the compaction.
	it("returns nothing, so compaction is never cancelled", async () => {
		const h = harness(dir);
		expect(await h.beforeCompact(92)).toBeUndefined();
	});

	it("stays quiet on a compaction below the threshold", async () => {
		const h = harness(dir);
		await h.beforeCompact(40);
		expect(h.notes()).toHaveLength(0);
	});

	it("only reports in notify mode", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "notify" } });
		await h.settle(85);

		expect(h.notes()).toHaveLength(0);
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0].message).toContain("Run /handoff");
	});

	it("does nothing at all when off", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "off" } });
		await h.settle(99);

		expect(h.notes()).toHaveLength(0);
		expect(h.notifications).toHaveLength(0);
		expect(h.dialogs).toHaveLength(0);
	});

	// A mechanical note would supersede the richer one as "newest pending".
	it("stands down once /handoff has written a note this session", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" }, handoffWritten: true });
		await h.settle(95);
		expect(h.notes()).toHaveLength(0);
	});

	it("warns instead of writing when the session is not recorded", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" }, sessionFile: undefined });
		await h.settle(85);

		expect(h.notes()).toHaveLength(0);
		expect(h.notifications[0].level).toBe("warning");
		expect(h.notifications[0].message).toContain("--no-session");
	});

	it("writes nothing when the branch holds no assistant message", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto" }, entries: [ASSISTANT_TURN[0]] });
		await h.settle(85);
		expect(h.notes()).toHaveLength(0);
	});

	it("reports a bad env var once, on the first settle", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto", [THRESHOLD_ENV]: "wat" } });
		await h.settle(10);
		await h.settle(20);

		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0].level).toBe("warning");
		expect(h.notifications[0].message).toContain(THRESHOLD_ENV);
	});

	it("honors a custom threshold", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "auto", [THRESHOLD_ENV]: "20" } });
		await h.settle(25);
		expect(h.notes()).toHaveLength(1);
	});
});

describe("watcher spawn mode", () => {
	const SPAWN = { [MODE_ENV]: "spawn" };
	const composed = async () => ({ body: "## Context\nComposed by the model.\n", kickoff: "Finish the parser" });

	// The chain counter is module state — it has to survive `newSession`, which is exactly why
	// a per-instance counter would never reach any cap.
	beforeEach(() => {
		resetSpawnGeneration();
	});

	it("writes the note and starts a successor holding its kickoff", async () => {
		const h = harness(dir, { env: SPAWN, compose: composed });
		await h.settle(85);

		const notes = h.notes();
		expect(notes).toHaveLength(1);
		expect(notes[0].body).toContain("Composed by the model.");
		expect(notes[0].frontmatter.kickoff).toBe("Finish the parser");
		// The successor's first prompt is the kickoff, so the reader's queued memo and the
		// marching orders land in the same turn.
		expect(h.spawns).toEqual(["Finish the parser"]);
	});

	// A thin note plus ask_predecessor beats no successor: the free tier throttles routinely,
	// and the chain has to survive it.
	it("falls back to the mechanical note when the composer fails", async () => {
		const h = harness(dir, {
			env: SPAWN,
			compose: async () => {
				throw new Error("429 quota exceeded");
			},
		});
		await h.settle(85);

		expect(h.notes()).toHaveLength(1);
		expect(h.notes()[0].body).toContain("mid-session at 85% context usage");
		expect(h.spawns).toHaveLength(1);
		expect(h.notifications.some((n) => n.message.includes("429 quota exceeded"))).toBe(true);
	});

	// Not an error — no model, or nothing to summarize — but the successor gets a thinner note
	// than the mode advertises, so silence would be the wrong answer.
	it("says so when the composer had nothing to compose from", async () => {
		const h = harness(dir, { env: SPAWN, compose: async () => undefined });
		await h.settle(85);

		expect(h.notifications.some((n) => n.message.includes("Nothing to compose from"))).toBe(true);
		expect(h.notes()[0].body).toContain("mid-session at 85% context usage");
		expect(h.spawns).toHaveLength(1);
	});

	it("spawns with a mechanical kickoff when no composer is wired", async () => {
		const h = harness(dir, { env: SPAWN });
		await h.settle(85);
		expect(h.spawns).toEqual(["Continue: Wire the watcher"]);
	});

	// Replacing the session inside the agent run is the stale-context footgun: everything
	// downstream of the compaction — the rest of the run, the settle emit — would hold a
	// context whose session no longer exists.
	it("never spawns from the compaction path; the settle that follows does it", async () => {
		const h = harness(dir, { env: SPAWN, compose: composed });
		await h.beforeCompact(92);

		expect(h.notes()).toHaveLength(1);
		expect(h.spawns).toHaveLength(0);

		await h.settle(null);
		expect(h.spawns).toEqual(["Finish the parser"]);
		// The deferred spawn consumed the settle; no second note.
		expect(h.notes()).toHaveLength(1);
	});

	it("carries the deferred spawn exactly once", async () => {
		const h = harness(dir, { env: SPAWN });
		await h.beforeCompact(92);
		await h.settle(null);
		await h.settle(null);
		expect(h.spawns).toHaveLength(1);
	});

	// Queued follow-ups mean the session is not done, whatever the context gauge says.
	it("writes the note but does not spawn while messages are queued", async () => {
		const h = harness(dir, { env: SPAWN, pendingMessages: true });
		await h.settle(85);

		expect(h.notes()).toHaveLength(1);
		expect(h.spawns).toHaveLength(0);
		expect(h.notifications.at(-1)?.message).toContain("queued messages");
	});

	// The cap is a backstop against a runaway chain, not a governor: each spawn still needs a
	// genuine crossing.
	it("degrades to auto once the per-process cap is reached", async () => {
		const first = harness(dir, { env: { ...SPAWN, [SPAWN_MAX_ENV]: "1" } });
		await first.settle(85);
		expect(first.spawns).toHaveLength(1);

		// A successor session: new extension instance and new session id, same process, so the
		// module-level counter is the only thing that carries the chain's history.
		const second = harness(dir, { env: { ...SPAWN, [SPAWN_MAX_ENV]: "1" }, sessionId: "019fee64-heir" });
		await second.settle(85);

		expect(second.notes()).toHaveLength(2);
		expect(second.spawns).toHaveLength(0);
		expect(second.notifications.at(-1)?.message).toContain(SPAWN_MAX_ENV);
	});

	it("never spawns at all with a cap of zero", async () => {
		const h = harness(dir, { env: { ...SPAWN, [SPAWN_MAX_ENV]: "0" } });
		await h.settle(85);

		expect(h.notes()).toHaveLength(1);
		expect(h.spawns).toHaveLength(0);
	});

	// Cancelled means the session was never replaced, so this context is still alive to say so.
	it("reports a cancelled successor and leaves the note in place", async () => {
		const h = harness(dir, { env: SPAWN, newSessionCancelled: true });
		await h.settle(85);

		expect(h.notes()).toHaveLength(1);
		expect(h.spawns).toHaveLength(0);
		expect(h.notifications.at(-1)?.message).toContain("cancelled");
	});

	it("stands down entirely once /handoff has written a note", async () => {
		const h = harness(dir, { env: SPAWN, handoffWritten: true });
		await h.settle(95);

		expect(h.notes()).toHaveLength(0);
		expect(h.spawns).toHaveLength(0);
	});

	// No session file means no transcript for the successor to read back through.
	it("does not spawn when the session is not recorded", async () => {
		const h = harness(dir, { env: SPAWN, sessionFile: undefined });
		await h.settle(85);

		expect(h.notes()).toHaveLength(0);
		expect(h.spawns).toHaveLength(0);
	});

	it("does not compose when the crossing cannot spawn anyway", async () => {
		let calls = 0;
		const h = harness(dir, {
			env: SPAWN,
			pendingMessages: true,
			compose: async () => {
				calls++;
				return { body: "unused", kickoff: "unused" };
			},
		});
		await h.settle(85);

		expect(calls).toBe(0);
		expect(h.notes()).toHaveLength(1);
	});
});
