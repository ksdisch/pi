import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveNote, HANDOFF_SCHEMA, type HandoffNote, writeNote } from "../notes.ts";
import { GRACE_MS, MODE_ENV, POLL_MS, registerRetire } from "../retire.ts";

const WRITER = "019fee63-1111-7000-8000-000000000001";
const CONSUMER = "019fee99-2222-7000-8000-000000000002";

/** Every note these tests write is stamped with this, so "after the note" is unambiguous. */
const NOTE_CREATED = "2026-08-12T10:00:00.000Z";

const AUTO = { [MODE_ENV]: "auto" };

type Notification = { message: string; level: string | undefined };

function entryAt(timestamp: string): SessionEntry {
	return {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp,
		message: { role: "assistant", content: [{ type: "text", text: "Still here." }], timestamp: 0 },
	} as SessionEntry;
}

interface HarnessOptions {
	env?: Record<string, string | undefined>;
	/** Path of the note `/handoff` wrote this run. Mutable through `handedOff()`. */
	notePath?: string;
	sessionId?: string;
	idle?: boolean;
	pendingMessages?: boolean;
	/** The session's branch. Its last entry's timestamp is the activity-since-the-note signal. */
	entries?: SessionEntry[];
}

/**
 * Minimal stand-in for the parts of ExtensionAPI/ExtensionContext retirement touches.
 * What these tests cover is the wiring: when the poll runs, what it reports, and that it
 * stops.
 */
function harness(cwd: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: Notification[] = [];
	let notePath = options.notePath;
	let shutdowns = 0;
	let digestSuppressed = false;

	const pi = {
		on: (event: string, registered: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, registered);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
		sessionManager: {
			getSessionId: () => options.sessionId ?? WRITER,
			getBranch: () => options.entries ?? [],
		},
		isIdle: () => options.idle ?? true,
		hasPendingMessages: () => options.pendingMessages ?? false,
		shutdown: () => {
			shutdowns++;
		},
	} as unknown as ExtensionContext;

	registerRetire(pi, {
		handoffNotePath: () => notePath,
		suppressShutdownDigest: () => {
			digestSuppressed = true;
		},
		env: options.env ?? {},
	});

	return {
		notifications,
		shutdowns: () => shutdowns,
		digestSuppressed: () => digestSuppressed,
		start: (reason = "startup") => handlers.get("session_start")?.({ type: "session_start", reason }, ctx),
		shutdown: (reason = "quit") => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, ctx),
		/** Stand in for `/handoff` having run: it recorded the note it just wrote. */
		handedOff: (path: string) => {
			notePath = path;
		},
		poll: async (times = 1) => {
			await vi.advanceTimersByTimeAsync(POLL_MS * times);
		},
		grace: async () => {
			await vi.advanceTimersByTimeAsync(GRACE_MS);
		},
	};
}

/** Write a pending note the way `/handoff` does; returns the path it would record. */
function pendingNote(cwd: string, sessionId = WRITER, created = NOTE_CREATED): string {
	const note: HandoffNote = {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: sessionId,
			cwd,
			created,
			source: "command",
			kickoff: "Continue the retirement build",
		},
		body: "## Context\nHanded off.\n",
	};
	return writeNote(cwd, note);
}

/** Someone else picked the note up: archived and stamped, the way the reader does it. */
function consume(cwd: string, path: string, consumedBy = CONSUMER): void {
	archiveNote(cwd, path, { consumed_by: consumedBy, consumed_at: "2026-08-12T10:05:00.000Z" });
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-retire-wiring-"));
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

describe("retirement wiring", () => {
	it("reports once its own note has been consumed", async () => {
		const h = harness(dir);
		h.start();
		const path = pendingNote(dir);
		h.handedOff(path);
		consume(dir, path);

		await h.poll();
		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0].message).toBe(
			`Handoff consumed by session ${CONSUMER.slice(0, 8)}; this session can retire.`,
		);
	});

	// The predicate stays true forever once it fires; a poll that keeps reporting it would
	// notify every 30 s for the rest of the session.
	it("reports only once", async () => {
		const h = harness(dir);
		h.start();
		const path = pendingNote(dir);
		h.handedOff(path);
		consume(dir, path);

		await h.poll(5);
		expect(h.notifications).toHaveLength(1);
	});

	// The scan is gated on this session having handed off. Without the gate every pi session
	// in the repo would readdir the archive twice a minute to learn nothing.
	it("stays quiet until this session has written a note", async () => {
		const h = harness(dir);
		h.start();
		const path = pendingNote(dir);
		consume(dir, path);

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);

		h.handedOff(path);
		await h.poll();
		expect(h.notifications).toHaveLength(1);
	});

	it("stays quiet while its note is still pending", async () => {
		const h = harness(dir, { notePath: pendingNote(dir) });
		h.start();

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("ignores another session's consumed note", async () => {
		const h = harness(dir, { notePath: pendingNote(dir) });
		h.start();
		consume(dir, pendingNote(dir, CONSUMER), WRITER);

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	// Identity is the note, not the session id: ids outlive their process, so a resumed
	// session that hands off again must not fire on the handoff it made in a previous life.
	it("ignores an older consumed note carrying this session's id", async () => {
		const stale = pendingNote(dir, WRITER, "2026-08-12T08:00:00.000Z");
		consume(dir, stale);
		const h = harness(dir, { notePath: pendingNote(dir) });
		h.start();

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	// The reader stamps notes it ingests at startup with its own session id, so a resumed
	// session can end up as its own note's consumer. That is nobody's cue to exit.
	it("ignores a note this session consumed itself", async () => {
		const path = pendingNote(dir);
		consume(dir, path, WRITER);
		const h = harness(dir, { notePath: path });
		h.start();

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("never polls when retirement is off", async () => {
		const path = pendingNote(dir);
		consume(dir, path);
		const h = harness(dir, { env: { [MODE_ENV]: "off" }, notePath: path });
		h.start();

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	// session_shutdown fires for reload/new/resume/fork as well as quit — every path that
	// replaces this extension instance. A leaked interval would outlive its runtime.
	it("tears the poll down on shutdown", async () => {
		const path = pendingNote(dir);
		const h = harness(dir, { notePath: path });
		h.start();
		h.shutdown("new");
		consume(dir, path);

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("arms exactly one poll across repeated session starts", async () => {
		const path = pendingNote(dir);
		const h = harness(dir, { notePath: path });
		h.start();
		h.start("new");
		consume(dir, path);

		await h.poll();
		expect(h.notifications).toHaveLength(1);
	});

	it("reports a bad env var at session start", () => {
		const h = harness(dir, { env: { [MODE_ENV]: "enabled" } });
		h.start();

		expect(h.notifications).toHaveLength(1);
		expect(h.notifications[0].level).toBe("warning");
		expect(h.notifications[0].message).toContain(MODE_ENV);
	});
});

describe("retirement auto mode", () => {
	/** Detect the consumed note and arm the grace timer. */
	async function detect(h: ReturnType<typeof harness>, path: string): Promise<void> {
		h.start();
		consume(dir, path);
		await h.poll();
	}

	/** An auto-mode session that has handed off, plus the path of the note it wrote. */
	function armed(options: Omit<HarnessOptions, "env" | "notePath"> = {}) {
		const path = pendingNote(dir);
		return { h: harness(dir, { env: AUTO, notePath: path, ...options }), path };
	}

	it("shuts the session down after the grace period", async () => {
		const { h, path } = armed();
		await detect(h, path);

		// The announcement is the whole warning; nothing has happened yet.
		expect(h.shutdowns()).toBe(0);
		expect(h.notifications).toHaveLength(1);

		await h.grace();
		expect(h.shutdowns()).toBe(1);
		expect(h.notifications.at(-1)?.message).toContain("Retiring");
	});

	// Otherwise the exit drops a fresh pending note re-advertising work that was already
	// picked up, and the next session ingests its own predecessor's ghost.
	it("suppresses the shutdown digest before exiting", async () => {
		const { h, path } = armed();
		await detect(h, path);
		expect(h.digestSuppressed()).toBe(false);

		await h.grace();
		expect(h.digestSuppressed()).toBe(true);
	});

	it("notifies but never exits in the default mode", async () => {
		const path = pendingNote(dir);
		const h = harness(dir, { notePath: path });
		await detect(h, path);
		await h.grace();

		expect(h.notifications).toHaveLength(1);
		expect(h.shutdowns()).toBe(0);
	});

	// A session that came back to life during the grace window keeps it. Each guard is
	// re-read at expiry, not at detection, for exactly this reason.
	it.each([
		["the agent is streaming", { idle: false }],
		["messages are queued", { pendingMessages: true }],
		["the session worked after the note was written", { entries: [entryAt("2026-08-12T11:00:00.000Z")] }],
	])("downgrades to notify when %s", async (_label, guard) => {
		const { h, path } = armed(guard);
		await detect(h, path);
		await h.grace();

		expect(h.shutdowns()).toBe(0);
		expect(h.digestSuppressed()).toBe(false);
		expect(h.notifications.at(-1)?.message).toContain("still working");
	});

	// Work that predates the handoff is what the note already describes.
	it("retires despite session entries older than the note", async () => {
		const { h, path } = armed({ entries: [entryAt("2026-08-12T09:00:00.000Z")] });
		await detect(h, path);
		await h.grace();

		expect(h.shutdowns()).toBe(1);
	});

	// A quit during the grace window is the user retiring the session themselves; the timer
	// must not fire into a torn-down runtime afterwards.
	it("cancels the pending retirement when the session shuts down first", async () => {
		const { h, path } = armed();
		await detect(h, path);
		h.shutdown();
		await h.grace();

		expect(h.shutdowns()).toBe(0);
	});
});
