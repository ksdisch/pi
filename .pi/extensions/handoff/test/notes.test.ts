import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	archiveDir,
	archiveNote,
	HANDOFF_SCHEMA,
	type HandoffNote,
	handoffsDir,
	listPendingNotePaths,
	noteFilename,
	parseNote,
	readNote,
	serializeNote,
	writeNote,
} from "../notes.ts";

function sampleNote(overrides: Partial<HandoffNote["frontmatter"]> = {}): HandoffNote {
	return {
		frontmatter: {
			schema: HANDOFF_SCHEMA,
			session_id: "019feda9-55bc-797d-8b97-4fe03f430270",
			session_file: "/Users/kyle/.pi/agent/sessions/--p--/2026-08-10T21-52-05-564Z_019feda9.jsonl",
			cwd: "/Users/kyle/Projects/foo",
			created: "2026-08-10T22:15:00.000Z",
			source: "digest",
			model: "google/gemini-3.6-flash",
			kickoff: "Continue implementing the reader module",
			...overrides,
		},
		body: "## Context\nWhat we were doing.\n\n## Next steps\nWire archive-on-delivery.\n",
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-handoff-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("serialize/parse round-trip", () => {
	it("preserves every frontmatter field and the body", () => {
		const note = sampleNote();
		const parsed = parseNote(serializeNote(note));
		expect(parsed).toEqual(note);
	});

	it("survives a kickoff containing a colon, quotes, and a hash", () => {
		const kickoff = 'Fix: the "reader" module # not a comment';
		const parsed = parseNote(serializeNote(sampleNote({ kickoff })));
		expect(parsed?.frontmatter.kickoff).toBe(kickoff);
	});

	it("survives a kickoff containing a newline", () => {
		const kickoff = "First line\nSecond line";
		const parsed = parseNote(serializeNote(sampleNote({ kickoff })));
		expect(parsed?.frontmatter.kickoff).toBe(kickoff);
	});

	it("keeps a body that contains its own --- separators", () => {
		const note = sampleNote();
		note.body = "## Context\n\n---\n\nA horizontal rule above.\n";
		const parsed = parseNote(serializeNote(note));
		expect(parsed?.body).toBe(note.body);
	});

	it("omits optional fields that are absent", () => {
		const note = sampleNote();
		delete note.frontmatter.model;
		delete note.frontmatter.session_file;
		const text = serializeNote(note);
		expect(text).not.toContain("model:");
		expect(text).not.toContain("session_file:");
		expect(parseNote(text)).toEqual(note);
	});

	it("emits plain scalars for ordinary values", () => {
		expect(serializeNote(sampleNote())).toContain("created: 2026-08-10T22:15:00.000Z");
	});

	it("emits frontmatter in the documented key order", () => {
		const keys = serializeNote(sampleNote())
			.split("\n")
			.slice(1, 9)
			.map((line) => line.split(":")[0]);
		expect(keys).toEqual(["schema", "session_id", "session_file", "cwd", "created", "source", "model", "kickoff"]);
	});
});

describe("parseNote rejection", () => {
	it("rejects a file with no frontmatter", () => {
		expect(parseNote("just a body\n")).toBeUndefined();
	});

	it("rejects unterminated frontmatter", () => {
		expect(parseNote(`---\nschema: ${HANDOFF_SCHEMA}\nsession_id: a\n`)).toBeUndefined();
	});

	it("rejects an unknown schema", () => {
		expect(parseNote(serializeNote(sampleNote({ schema: "pi-handoff/v2" })))).toBeUndefined();
	});

	it("rejects an unknown source", () => {
		const text = serializeNote(sampleNote()).replace("source: digest", "source: telepathy");
		expect(parseNote(text)).toBeUndefined();
	});

	it("rejects a malformed frontmatter line", () => {
		const text = serializeNote(sampleNote()).replace("cwd: ", "cwd ");
		expect(parseNote(text)).toBeUndefined();
	});

	it("defaults a missing kickoff rather than discarding the note", () => {
		const text = serializeNote(sampleNote()).replace(/^kickoff:.*\n/m, "");
		expect(parseNote(text)?.frontmatter.kickoff).toBe("");
	});
});

describe("noteFilename", () => {
	it("mirrors pi session-file naming and truncates the session id", () => {
		expect(noteFilename("2026-08-10T22:15:00.000Z", "019feda9-55bc-797d")).toBe(
			"2026-08-10T22-15-00-000Z_019feda9.md",
		);
	});
});

describe("writeNote / listPendingNotePaths", () => {
	it("writes into .pi/handoffs and reads back identically", () => {
		const note = sampleNote();
		const path = writeNote(dir, note);
		expect(path).toBe(join(handoffsDir(dir), noteFilename(note.frontmatter.created, note.frontmatter.session_id)));
		expect(readNote(path)).toEqual(note);
	});

	it("returns an empty list when the directory does not exist", () => {
		expect(listPendingNotePaths(dir)).toEqual([]);
	});

	it("sorts oldest first and ignores archive/ and .tmp leftovers", () => {
		writeNote(dir, sampleNote({ created: "2026-08-10T22:15:00.000Z", session_id: "bbbbbbbb" }));
		writeNote(dir, sampleNote({ created: "2026-08-09T10:00:00.000Z", session_id: "aaaaaaaa" }));
		mkdirSync(archiveDir(dir), { recursive: true });
		writeFileSync(join(archiveDir(dir), "2026-01-01T00-00-00-000Z_cccccccc.md"), "archived");
		writeFileSync(join(handoffsDir(dir), "2026-08-11T00-00-00-000Z_dddddddd.md.tmp"), "half-written");

		expect(listPendingNotePaths(dir).map((p) => p.split("/").pop())).toEqual([
			"2026-08-09T10-00-00-000Z_aaaaaaaa.md",
			"2026-08-10T22-15-00-000Z_bbbbbbbb.md",
		]);
	});

	it("leaves no .tmp file behind after a write", () => {
		const path = writeNote(dir, sampleNote());
		expect(existsSync(`${path}.tmp`)).toBe(false);
	});
});

describe("archiveNote", () => {
	it("moves the note into archive/ and stamps it", () => {
		const path = writeNote(dir, sampleNote());
		const stamped = archiveNote(dir, path, { consumed_by: "successor-id", consumed_at: "2026-08-11T09:00:00.000Z" });

		expect(stamped).toBe(true);
		expect(existsSync(path)).toBe(false);
		const archived = readNote(join(archiveDir(dir), path.split("/").pop() as string));
		expect(archived?.frontmatter.consumed_by).toBe("successor-id");
		expect(archived?.frontmatter.consumed_at).toBe("2026-08-11T09:00:00.000Z");
		expect(archived?.body).toBe(sampleNote().body);
	});

	it("returns false when another session already claimed the note", () => {
		const path = writeNote(dir, sampleNote());
		expect(archiveNote(dir, path, { consumed_by: "first" })).toBe(true);
		expect(archiveNote(dir, path, { consumed_by: "second" })).toBe(false);
		expect(readNote(join(archiveDir(dir), path.split("/").pop() as string))?.frontmatter.consumed_by).toBe("first");
	});

	it("still archives a note whose frontmatter cannot be parsed", () => {
		mkdirSync(handoffsDir(dir), { recursive: true });
		const path = join(handoffsDir(dir), "2026-08-10T22-15-00-000Z_corrupt0.md");
		writeFileSync(path, "not a note");

		expect(archiveNote(dir, path, { superseded_by: "newer.md" })).toBe(true);
		expect(existsSync(path)).toBe(false);
		expect(readFileSync(join(archiveDir(dir), "2026-08-10T22-15-00-000Z_corrupt0.md"), "utf8")).toBe("not a note");
	});
});
