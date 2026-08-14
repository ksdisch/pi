/**
 * Repro + regression tests for the wait-start boundary bug (BACKLOG item 9).
 *
 * The bug: the watcher tick could claim a message (mark it seen and queue a steer
 * delivery) while an agent run was in progress. A queued steer message cannot surface
 * until the run's next LLM call, but an `intercom_wait` issued in that same run polls
 * the shared `seen` set — so the wait ran its whole timeout deaf to a message that had
 * already arrived, and the message surfaced only after the wait returned, out of
 * order. Pilots 6–7 recorded 12+ live instances (60–94s of deafness, manufactured
 * `arm-timeout`s); see `.pi/playtest/PILOT-2026-08-14-run{6,7}.md`.
 *
 * The fix: the tick stands down while `agent_start`..`agent_end`/`agent_settled` is
 * open, leaving messages unclaimed for any wait to pick up instantly. These tests
 * drive the real extension entry point through a fake ExtensionAPI with fake timers;
 * the first test fails on the pre-fix extension (the wait times out deaf) and pins
 * the fixed behaviour.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import intercomExtension from "../index.ts";
import { INTERCOM_SCHEMA, writeMessage } from "../store.ts";

const SELF = "01a00000-aaaa-7bbb-8ccc-dddd11112222";
const PEER = "01a00000-1111-7222-8333-444455556666";
const POLL_MS = 1500;

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: Array<{ type: string; text: string }>; details?: Record<string, unknown> }>;
}

function makeFakePi(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, RegisteredTool>();
	const sent: Array<{ message: { content: string }; options: { deliverAs?: string; triggerTurn?: boolean } }> = [];
	const pi = {
		on(event: string, handler: Handler): void {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool: RegisteredTool): void {
			tools.set(tool.name, tool);
		},
		registerCommand(): void {},
		registerMessageRenderer(): void {},
		sendMessage(message: { content: string }, options: { deliverAs?: string; triggerTurn?: boolean }): void {
			sent.push({ message, options });
		},
	};
	const ctx = { cwd, sessionManager: { getSessionId: () => SELF } };
	function fire(event: string, payload: Record<string, unknown> = {}): void {
		for (const handler of handlers.get(event) ?? []) void handler({ type: event, ...payload }, ctx);
	}
	return { pi, ctx, fire, tools, sent };
}

function peerMessage(cwd: string, channel: string, text: string, seq: number): void {
	writeMessage(
		cwd,
		{
			schema: INTERCOM_SCHEMA,
			channel,
			sender: PEER,
			alias: "peer",
			created: new Date().toISOString(),
			text,
		},
		seq,
	);
}

let cwd: string;
let fake: ReturnType<typeof makeFakePi>;

beforeEach(() => {
	vi.useFakeTimers();
	cwd = mkdtempSync(join(tmpdir(), "pi-intercom-idx-"));
	fake = makeFakePi(cwd);
	// biome-ignore lint/suspicious/noExplicitAny: the fake implements the used surface only
	intercomExtension(fake.pi as any);
	fake.fire("session_start");
});

afterEach(() => {
	fake.fire("session_shutdown");
	vi.useRealTimers();
	rmSync(cwd, { recursive: true, force: true });
});

/** Join the channel by sending on it once; the send's own file is skipped on scans. */
async function joinChannel(channel: string): Promise<void> {
	const send = fake.tools.get("intercom_send");
	if (!send) throw new Error("intercom_send not registered");
	await send.execute("t1", { channel, message: "joining", alias: "self" }, undefined, undefined, fake.ctx);
}

describe("wait-start boundary (the pilots 6-7 deafness bug)", () => {
	it("a message arriving mid-run is NOT claimed by the tick and an intercom_wait returns it immediately", async () => {
		await joinChannel("dev");
		fake.fire("agent_start");

		// Peer message lands in the mid-turn gap, then the tick fires before the wait
		// starts — the exact sequence that produced 60-94s of deafness in pilots 6-7.
		peerMessage(cwd, "dev", "arming on freeze — cast when ready!", 0);
		await vi.advanceTimersByTimeAsync(POLL_MS + 100);
		expect(fake.sent).toHaveLength(0); // tick stood down: nothing claimed, nothing queued

		const wait = fake.tools.get("intercom_wait");
		if (!wait) throw new Error("intercom_wait not registered");
		const result = await wait.execute("t2", { channel: "dev", timeout_seconds: 60 }, undefined, undefined, fake.ctx);
		expect(result.details?.count).toBe(1);
		expect(result.content[0]?.text).toContain("arming on freeze");
		expect(fake.sent).toHaveLength(0); // and no duplicate steer delivery ever follows
	});

	it("idle delivery is unchanged: after agent_end the tick delivers once, steer + triggerTurn, no re-delivery", async () => {
		await joinChannel("dev");
		fake.fire("agent_start");
		fake.fire("agent_end");

		peerMessage(cwd, "dev", "platform cast — it's ready", 0);
		await vi.advanceTimersByTimeAsync(POLL_MS + 100);
		expect(fake.sent).toHaveLength(1);
		expect(fake.sent[0]?.options).toEqual({ deliverAs: "steer", triggerTurn: true });
		expect(fake.sent[0]?.message.content).toContain("platform cast");

		// Claimed messages stay claimed: a later wait does not return them again.
		const wait = fake.tools.get("intercom_wait");
		if (!wait) throw new Error("intercom_wait not registered");
		const pending = wait.execute("t3", { channel: "dev", timeout_seconds: 2 }, undefined, undefined, fake.ctx);
		await vi.advanceTimersByTimeAsync(2500);
		const result = await pending;
		expect(result.details?.count).toBe(0);
		expect(fake.sent).toHaveLength(1);
	});

	it("agent_settled alone also reopens the tick (agent_end missed on an unusual path)", async () => {
		await joinChannel("dev");
		fake.fire("agent_start");
		fake.fire("agent_settled");

		peerMessage(cwd, "dev", "settled-path delivery", 0);
		await vi.advanceTimersByTimeAsync(POLL_MS + 100);
		expect(fake.sent).toHaveLength(1);
	});

	it("a wait that starts before the message arrives still receives it mid-run (the pre-existing good path)", async () => {
		await joinChannel("dev");
		fake.fire("agent_start");

		const wait = fake.tools.get("intercom_wait");
		if (!wait) throw new Error("intercom_wait not registered");
		const pending = wait.execute("t4", { channel: "dev", timeout_seconds: 60 }, undefined, undefined, fake.ctx);
		await vi.advanceTimersByTimeAsync(1000);
		peerMessage(cwd, "dev", "late but heard", 0);
		await vi.advanceTimersByTimeAsync(600); // one wait poll
		const result = await pending;
		expect(result.details?.count).toBe(1);
		expect(result.content[0]?.text).toContain("late but heard");
	});
});
