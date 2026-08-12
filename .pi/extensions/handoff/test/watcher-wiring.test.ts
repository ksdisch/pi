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
import { MODE_ENV, PROPOSE_TIMEOUT_MS, registerWatcher, THRESHOLD_ENV } from "../watcher.ts";

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
			getSessionId: () => "019fee63-writer",
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/sessions/019fee63.jsonl"),
			getBranch: () => options.entries ?? ASSISTANT_TURN,
		},
	} as unknown as ExtensionContext;

	let tick = 0;
	registerWatcher(pi, {
		handoffWritten: () => options.handoffWritten ?? false,
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
