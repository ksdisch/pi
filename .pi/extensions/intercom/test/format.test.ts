import { describe, expect, it } from "vitest";
import { formatIncoming, senderLabel } from "../format.ts";
import { INTERCOM_SCHEMA, type IntercomMessage } from "../store.ts";

function message(overrides: Partial<IntercomMessage> = {}): IntercomMessage {
	return {
		schema: INTERCOM_SCHEMA,
		channel: "dev",
		sender: "019feda9-55bc-797d-8b97-4fe03f430270",
		created: "2026-08-11T10:00:00.000Z",
		text: "hello",
		...overrides,
	};
}

describe("senderLabel", () => {
	it("prefers the alias with the short id in parentheses", () => {
		expect(senderLabel(message({ alias: "laptop-player" }))).toBe("laptop-player (3f430270)");
	});

	it("falls back to the uuid tail, which two same-minute sessions do not share", () => {
		expect(senderLabel(message())).toBe("3f430270");
		expect(senderLabel(message({ sender: "019feda9-55bc-797d-8b97-4fe0deadbeef" }))).toBe("deadbeef");
	});
});

describe("formatIncoming", () => {
	it("puts a standalone banner first, one block per message, and a closing fence", () => {
		const text = formatIncoming("dev", [
			message({ text: "first" }),
			message({ alias: "phone-player", created: "2026-08-11T10:00:05.000Z", text: "second\n" }),
		]);
		expect(text).toBe(
			[
				"Intercom #dev — 2 new messages",
				"",
				"From 3f430270 at 2026-08-11T10:00:00.000Z:",
				"first",
				"",
				"From phone-player (3f430270) at 2026-08-11T10:00:05.000Z:",
				"second",
				"",
				"(end of intercom #dev traffic)",
			].join("\n"),
		);
	});

	it("uses the singular for one message", () => {
		expect(formatIncoming("dev", [message()])).toContain("1 new message\n");
	});

	it("keeps only the newest 50 messages and says how many were omitted", () => {
		const backlog = Array.from({ length: 53 }, (_, i) =>
			message({ created: `2026-08-11T10:00:${String(i).padStart(2, "0")}.000Z`, text: `msg ${i}` }),
		);
		const text = formatIncoming("dev", backlog);
		expect(text).toContain("50 new messages");
		expect(text).toContain("(3 older unread messages omitted; full history is in .pi/intercom/dev/)");
		expect(text).not.toContain("msg 2\n");
		expect(text).toContain("msg 52");
	});

	it("caps a giant message body at its head", () => {
		const text = formatIncoming("dev", [message({ text: "y".repeat(5000) })]);
		expect(text).toContain("…");
		expect(text.length).toBeLessThan(2300);
	});
});
