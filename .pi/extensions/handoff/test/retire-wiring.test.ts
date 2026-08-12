import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveNote, HANDOFF_SCHEMA, type HandoffNote, writeNote } from "../notes.ts";
import { MODE_ENV, POLL_MS, registerRetire } from "../retire.ts";

const WRITER = "019fee63-1111-7000-8000-000000000001";
const CONSUMER = "019fee99-2222-7000-8000-000000000002";

type Notification = { message: string; level: string | undefined };

interface HarnessOptions {
	env?: Record<string, string | undefined>;
	/** Whether this session has written a handoff note yet. Mutable through `writeNote()`. */
	noteWritten?: boolean;
	sessionId?: string;
}

/**
 * Minimal stand-in for the parts of ExtensionAPI/ExtensionContext retirement touches.
 * What these tests cover is the wiring: when the poll runs, what it reports, and that it
 * stops.
 */
function harness(cwd: string, options: HarnessOptions = {}) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: Notification[] = [];
	let noteWritten = options.noteWritten ?? false;

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
		},
	} as unknown as ExtensionContext;

	registerRetire(pi, { noteWritten: () => noteWritten, env: options.env ?? {} });

	return {
		notifications,
		start: (reason = "startup") => handlers.get("session_start")?.({ type: "session_start", reason }, ctx),
		shutdown: (reason = "quit") => handlers.get("session_shutdown")?.({ type: "session_shutdown", reason }, ctx),
		/** Stand in for `/handoff` having run: a note of ours now exists. */
		handedOff: () => {
			noteWritten = true;
		},
		poll: async (times = 1) => {
			await vi.advanceTimersByTimeAsync(POLL_MS * times);
		},
	};
}

/** Write a note as `sessionId` and archive it with the given stamp, the way the reader does. */
function archivedNote(cwd: string, sessionId: string, stamp: Partial<HandoffNote["frontmatter"]>): void {
	const note: HandoffNote = {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: sessionId,
			cwd,
			created: "2026-08-12T10:00:00.000Z",
			source: "command",
			kickoff: "Continue the retirement build",
		},
		body: "## Context\nHanded off.\n",
	};
	archiveNote(cwd, writeNote(cwd, note), stamp);
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
		h.handedOff();
		archivedNote(dir, WRITER, { consumed_by: CONSUMER, consumed_at: "2026-08-12T10:05:00.000Z" });

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
		h.handedOff();
		archivedNote(dir, WRITER, { consumed_by: CONSUMER });

		await h.poll(5);
		expect(h.notifications).toHaveLength(1);
	});

	// The scan is gated on this session having handed off. Without the gate every pi session
	// in the repo would readdir the archive twice a minute to learn nothing.
	it("stays quiet until this session has written a note", async () => {
		const h = harness(dir);
		h.start();
		archivedNote(dir, WRITER, { consumed_by: CONSUMER });

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);

		h.handedOff();
		await h.poll();
		expect(h.notifications).toHaveLength(1);
	});

	it("stays quiet while its note is still pending", async () => {
		const h = harness(dir, { noteWritten: true });
		h.start();
		writeNote(dir, {
			frontmatter: {
				schema: HANDOFF_SCHEMA,
				session_id: WRITER,
				cwd: dir,
				created: "2026-08-12T10:00:00.000Z",
				source: "command",
				kickoff: "Continue",
			},
			body: "## Context\nStill waiting.\n",
		});

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("ignores another session's consumed note", async () => {
		const h = harness(dir, { noteWritten: true });
		h.start();
		archivedNote(dir, CONSUMER, { consumed_by: WRITER });

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("never polls when retirement is off", async () => {
		const h = harness(dir, { env: { [MODE_ENV]: "off" }, noteWritten: true });
		h.start();
		archivedNote(dir, WRITER, { consumed_by: CONSUMER });

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	// session_shutdown fires for reload/new/resume/fork as well as quit — every path that
	// replaces this extension instance. A leaked interval would outlive its runtime.
	it("tears the poll down on shutdown", async () => {
		const h = harness(dir, { noteWritten: true });
		h.start();
		h.shutdown("new");
		archivedNote(dir, WRITER, { consumed_by: CONSUMER });

		await h.poll(3);
		expect(h.notifications).toHaveLength(0);
	});

	it("arms exactly one poll across repeated session starts", async () => {
		const h = harness(dir, { noteWritten: true });
		h.start();
		h.start("new");
		archivedNote(dir, WRITER, { consumed_by: CONSUMER });

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
