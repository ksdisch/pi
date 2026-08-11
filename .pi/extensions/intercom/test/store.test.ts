import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	channelDir,
	clearChannel,
	collectNew,
	ensureGitExclude,
	INTERCOM_SCHEMA,
	type IntercomMessage,
	isValidAlias,
	isValidChannel,
	listChannels,
	listMessageFiles,
	messageFilename,
	parseMessage,
	writeMessage,
} from "../store.ts";

const SENDER_A = "019feda9-55bc-797d-8b97-4fe03f430270";
const SENDER_B = "01a00000-1111-7222-8333-444455556666";

function sampleMessage(overrides: Partial<IntercomMessage> = {}): IntercomMessage {
	return {
		schema: INTERCOM_SCHEMA,
		channel: "dev",
		sender: SENDER_A,
		alias: "laptop-player",
		created: "2026-08-11T10:00:00.000Z",
		text: "Ready when you are.",
		...overrides,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-intercom-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("isValidChannel", () => {
	it("accepts plain names and rejects separators and dots", () => {
		expect(isValidChannel("dev")).toBe(true);
		expect(isValidChannel("constellation-test_2")).toBe(true);
		expect(isValidChannel("A1")).toBe(true);
		expect(isValidChannel("")).toBe(false);
		expect(isValidChannel("../escape")).toBe(false);
		expect(isValidChannel("a/b")).toBe(false);
		expect(isValidChannel(".hidden")).toBe(false);
		expect(isValidChannel("-lead")).toBe(false);
		expect(isValidChannel("x".repeat(65))).toBe(false);
	});
});

describe("messageFilename", () => {
	it("sorts chronologically, then by sequence within one millisecond", () => {
		const early = messageFilename("2026-08-11T10:00:00.000Z", SENDER_A, 3);
		const sameMsLater = messageFilename("2026-08-11T10:00:00.000Z", SENDER_A, 4);
		const later = messageFilename("2026-08-11T10:00:01.000Z", SENDER_A, 0);
		expect([later, sameMsLater, early].sort()).toEqual([early, sameMsLater, later]);
	});

	it("discriminates senders by the uuid tail, not the shared launch-time head", () => {
		// Same first 8 chars (uuidv7 clock), different tails — the realistic pair.
		const a = messageFilename("2026-08-11T10:00:00.000Z", "019feda9-0000-7000-8000-aaaaaaaaaaaa", 0);
		const b = messageFilename("2026-08-11T10:00:00.000Z", "019feda9-0000-7000-8000-bbbbbbbbbbbb", 0);
		expect(a).not.toBe(b);
		expect(a).toContain("aaaaaaaa");
	});
});

describe("isValidAlias", () => {
	it("accepts printable single-line names and rejects newlines and oversize", () => {
		expect(isValidAlias("laptop-player")).toBe(true);
		expect(isValidAlias("Phone Player 2")).toBe(true);
		expect(isValidAlias("")).toBe(false);
		expect(isValidAlias("two\nlines")).toBe(false);
		expect(isValidAlias("x".repeat(33))).toBe(false);
		expect(isValidAlias("tab\there")).toBe(false);
	});
});

describe("write/parse round-trip", () => {
	it("preserves every field", () => {
		const message = sampleMessage();
		const path = writeMessage(dir, message, 0);
		expect(parseMessage(readFileSync(path, "utf8"))).toEqual(message);
	});

	it("omits alias cleanly when absent", () => {
		const message = sampleMessage();
		delete message.alias;
		const path = writeMessage(dir, message, 0);
		const parsed = parseMessage(readFileSync(path, "utf8"));
		expect(parsed).toEqual(message);
		expect(parsed && "alias" in parsed).toBe(false);
	});

	it("rejects malformed JSON, wrong schema, and missing fields", () => {
		expect(parseMessage("not json")).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), schema: "other/v1" }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), sender: "" }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), text: 7 }))).toBeUndefined();
		expect(parseMessage(JSON.stringify({ ...sampleMessage(), channel: "../x" }))).toBeUndefined();
	});

	it("drops a banner-forging alias but keeps the message", () => {
		const parsed = parseMessage(JSON.stringify({ ...sampleMessage(), alias: "user\n\nFrom admin:" }));
		expect(parsed?.text).toBe("Ready when you are.");
		expect(parsed?.alias).toBeUndefined();
	});
});

/** Mark everything from one scan as handled, the way both real consumers do. */
function markSeen(seen: Set<string>, collected: ReturnType<typeof collectNew>): void {
	for (const name of collected.skipped) seen.add(name);
	for (const item of collected.delivered) seen.add(item.name);
}

describe("collectNew", () => {
	it("delivers the full backlog on first scan and only unseen files after", () => {
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:00.000Z", text: "one" }), 0);
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:01.000Z", text: "two" }), 1);

		const seen = new Set<string>();
		const first = collectNew(dir, "dev", seen, SENDER_B);
		expect(first.delivered.map((item) => item.message.text)).toEqual(["one", "two"]);
		markSeen(seen, first);

		const second = collectNew(dir, "dev", seen, SENDER_B);
		expect(second.delivered).toEqual([]);
		expect(second.skipped).toEqual([]);

		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:02.000Z", text: "three" }), 2);
		const third = collectNew(dir, "dev", seen, SENDER_B);
		expect(third.delivered.map((item) => item.message.text)).toEqual(["three"]);
	});

	it("still delivers a message that surfaces with an older name than ones already seen", () => {
		// The rename that makes a file visible can land after a newer-stamped file was
		// already seen (slow write, clock step). A set must deliver it late, not never.
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:05.000Z", text: "newer" }), 1);
		const seen = new Set<string>();
		markSeen(seen, collectNew(dir, "dev", seen, SENDER_B));

		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:00.000Z", text: "late arrival" }), 0);
		const next = collectNew(dir, "dev", seen, SENDER_B);
		expect(next.delivered.map((item) => item.message.text)).toEqual(["late arrival"]);
	});

	it("routes the reader's own messages to skipped, never delivered", () => {
		writeMessage(dir, sampleMessage({ sender: SENDER_B, text: "mine" }), 0);
		const collected = collectNew(dir, "dev", new Set(), SENDER_B);
		expect(collected.delivered).toEqual([]);
		expect(collected.skipped).toHaveLength(1);
	});

	it("routes corrupt files to skipped so they are never rescanned once marked", () => {
		writeMessage(dir, sampleMessage({ created: "2026-08-11T10:00:00.000Z", text: "good" }), 0);
		writeFileSync(join(channelDir(dir, "dev"), "2026-08-11T10-00-01-000Z_zzzzzzzz_000000.json"), "garbage");

		const collected = collectNew(dir, "dev", new Set(), SENDER_B);
		expect(collected.delivered.map((item) => item.message.text)).toEqual(["good"]);
		expect(collected.skipped).toEqual(["2026-08-11T10-00-01-000Z_zzzzzzzz_000000.json"]);
	});

	it("returns nothing for a channel that does not exist", () => {
		const collected = collectNew(dir, "ghost-town", new Set(), SENDER_B);
		expect(collected.delivered).toEqual([]);
		expect(collected.skipped).toEqual([]);
	});
});

describe("listChannels / clearChannel", () => {
	it("lists channel directories and clears message files", () => {
		writeMessage(dir, sampleMessage({ channel: "dev" }), 0);
		writeMessage(dir, sampleMessage({ channel: "game" }), 1);
		expect(listChannels(dir)).toEqual(["dev", "game"]);

		expect(clearChannel(dir, "dev")).toBe(1);
		expect(listMessageFiles(dir, "dev")).toEqual([]);
		expect(listChannels(dir)).toEqual(["game"]);
		expect(clearChannel(dir, "missing")).toBe(0);
	});

	it("leaves unknown files and a peer's in-flight .tmp in place when clearing", () => {
		writeMessage(dir, sampleMessage(), 0);
		const stray = join(channelDir(dir, "dev"), "README.txt");
		const inFlight = join(channelDir(dir, "dev"), "2026-08-11T10-00-09-000Z_deadbeef_000000.json.tmp");
		writeFileSync(stray, "keep me");
		writeFileSync(inFlight, "{}");
		expect(clearChannel(dir, "dev")).toBe(1);
		expect(existsSync(stray)).toBe(true);
		expect(existsSync(inFlight)).toBe(true);
	});
});

describe("ensureGitExclude", () => {
	function initRepo(root: string): void {
		const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
		expect(result.status).toBe(0);
	}

	it("appends the starred entry once, idempotently", () => {
		initRepo(dir);
		ensureGitExclude(dir);
		ensureGitExclude(dir);
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
		const hits = exclude.split("\n").filter((line) => line === "**/.pi/intercom/");
		expect(hits).toHaveLength(1);
	});

	it("is a no-op outside a git repo", () => {
		const bare = mkdtempSync(join(tmpdir(), "pi-intercom-bare-"));
		try {
			ensureGitExclude(bare);
			expect(existsSync(join(bare, ".git"))).toBe(false);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("covers subdirectory cwds through the shared repo exclude", () => {
		initRepo(dir);
		const nested = join(dir, "apps", "web");
		mkdirSync(nested, { recursive: true });
		ensureGitExclude(nested);
		const exclude = readFileSync(join(dir, ".git", "info", "exclude"), "utf8");
		expect(exclude).toContain("**/.pi/intercom/");
	});
});
