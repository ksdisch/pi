import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveNote, HANDOFF_SCHEMA, type HandoffNote, writeNote } from "../notes.ts";
import { DEFAULT_MODE, findConsumedNote, isConsumedNote, MODE_ENV, readRetireConfig } from "../retire.ts";

const WRITER = "019fee63-1111-7000-8000-000000000001";
const OTHER = "019fee99-2222-7000-8000-000000000002";

function note(overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: WRITER,
			cwd: "/Users/kyle/Projects/foo",
			created: "2026-08-12T10:00:00.000Z",
			source: "command",
			kickoff: "Continue the retirement build",
			...overrides,
		},
		body: "## Context\nHanded off.\n",
	};
}

describe("readRetireConfig", () => {
	// Ending a session nobody asked to end is the opt-in half; noticing is free.
	it("defaults to notify with nothing set", () => {
		expect(readRetireConfig({})).toEqual({ config: { mode: "notify" }, warnings: [] });
		expect(DEFAULT_MODE).toBe("notify");
	});

	it.each(["off", "notify", "auto"] as const)("accepts mode %s", (mode) => {
		expect(readRetireConfig({ [MODE_ENV]: mode }).config.mode).toBe(mode);
	});

	it("accepts a mode with stray case and whitespace, as a shell would hand it over", () => {
		expect(readRetireConfig({ [MODE_ENV]: " Auto \n" }).config.mode).toBe("auto");
	});

	// The failure mode this guards: the user believes retirement is armed, and nothing ever
	// tells them it is not.
	it("warns and keeps the default on an unknown mode", () => {
		const result = readRetireConfig({ [MODE_ENV]: "yes" });
		expect(result.config.mode).toBe(DEFAULT_MODE);
		expect(result.warnings).toEqual([`${MODE_ENV}="yes" is not one of off, notify, auto; using "${DEFAULT_MODE}".`]);
	});

	it("treats an empty value as unset, not as a mistake", () => {
		expect(readRetireConfig({ [MODE_ENV]: "" })).toEqual({ config: { mode: DEFAULT_MODE }, warnings: [] });
	});
});

describe("isConsumedNote", () => {
	it("matches our own note once someone stamped it consumed", () => {
		expect(isConsumedNote(note({ consumed_by: OTHER }), WRITER)).toBe(true);
	});

	// A session id outlives its process (`pi -c` resumes through the id in the file header),
	// so a session can meet its own note again after a restart — and the reader stamps notes
	// it ingests at startup with its own id. "I picked up my own note" is nobody's cue to exit.
	it("does not accept a note this session consumed itself", () => {
		expect(isConsumedNote(note({ consumed_by: WRITER }), WRITER)).toBe(false);
	});

	it("ignores an unstamped note", () => {
		expect(isConsumedNote(note(), WRITER)).toBe(false);
	});

	// Superseded means a newer note won the briefing slot, not that this session's work was
	// ingested by anyone. Retiring on it would kill a session whose handoff nobody read.
	it("does not accept superseded_by as consumption", () => {
		expect(isConsumedNote(note({ superseded_by: "2026-08-12T11-00-00-000Z_019fee99.md" }), WRITER)).toBe(false);
	});

	it("ignores another session's consumed note", () => {
		expect(isConsumedNote(note({ session_id: OTHER, consumed_by: WRITER }), WRITER)).toBe(false);
	});
});

describe("findConsumedNote", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-handoff-retire-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Write a note the way `/handoff` does, and hand back the path it would record. */
	function written(overrides: Partial<HandoffNote["frontmatter"]> = {}): string {
		return writeNote(dir, note(overrides));
	}

	it("finds nothing when the note is still pending", () => {
		expect(findConsumedNote(dir, written(), WRITER)).toBeUndefined();
	});

	it("finds our note once it is archived with a consumed_by stamp", () => {
		const path = written();
		archiveNote(dir, path, { consumed_by: OTHER, consumed_at: "2026-08-12T10:05:00.000Z" });
		expect(findConsumedNote(dir, path, WRITER)?.note.frontmatter.consumed_by).toBe(OTHER);
	});

	it("ignores a note archived as superseded", () => {
		const path = written();
		archiveNote(dir, path, { superseded_by: "newer.md" });
		expect(findConsumedNote(dir, path, WRITER)).toBeUndefined();
	});

	it("ignores a note this session consumed itself", () => {
		const path = written();
		archiveNote(dir, path, { consumed_by: WRITER });
		expect(findConsumedNote(dir, path, WRITER)).toBeUndefined();
	});

	// Identity is the note, not the session id. A session id outlives its process, so an
	// id-only match would fire on a handoff consumed in a previous life — announcing the wrong
	// handoff, and under `auto` exiting while the note just written sat unread.
	it("ignores an older consumed note from the same session id", () => {
		const stale = written({ created: "2026-08-12T08:00:00.000Z" });
		archiveNote(dir, stale, { consumed_by: OTHER });
		const fresh = written({ created: "2026-08-12T12:00:00.000Z" });

		expect(findConsumedNote(dir, fresh, WRITER)).toBeUndefined();
	});

	// Basenames carry only 8 characters of the writer's id, so a same-millisecond collision
	// between two sessions is conceivable; the frontmatter comparison is what decides.
	it("rejects an archived note that is not ours despite the matching name", () => {
		const collider = `${WRITER.slice(0, 8)}-3333-7000-8000-000000000003`;
		const path = writeNote(dir, note({ session_id: collider }));
		archiveNote(dir, path, { consumed_by: OTHER });
		expect(findConsumedNote(dir, path, WRITER)).toBeUndefined();
	});
});
