import { describe, expect, it } from "vitest";
import { buildComposeUserMessage, splitKickoff } from "../compose.ts";

describe("splitKickoff", () => {
	it("splits the trailing KICKOFF line off the body", () => {
		const text = "## Context\nWe wired the reader.\n\nKICKOFF: Wire archive-on-delivery next.";
		expect(splitKickoff(text)).toEqual({
			body: "## Context\nWe wired the reader.",
			kickoff: "Wire archive-on-delivery next.",
		});
	});

	it("tolerates trailing blank lines and a stray rule after the marker", () => {
		const text = "## Context\nBody.\n\nKICKOFF: Do the thing.\n\n---\n\n";
		expect(splitKickoff(text).kickoff).toBe("Do the thing.");
	});

	it("returns the whole text when the model omitted the marker", () => {
		const text = "## Context\nBody.\n\n## Next steps\nDo the thing.";
		expect(splitKickoff(text)).toEqual({ body: text });
	});

	it("does not treat a KICKOFF mention in the middle of the note as the marker", () => {
		const text = "## Context\nKICKOFF: this is quoted mid-note.\n\n## Next steps\nCarry on.";
		expect(splitKickoff(text)).toEqual({ body: text });
	});

	it("ignores a marker with no content after it", () => {
		expect(splitKickoff("## Context\nBody.\n\nKICKOFF:").kickoff).toBeUndefined();
	});
});

describe("buildComposeUserMessage", () => {
	it("passes a goal through as the focus for Next steps", () => {
		const message = buildComposeUserMessage("[User]: hi", "finish the reader");
		expect(message).toContain("[User]: hi");
		expect(message).toContain("finish the reader");
		expect(message).toContain('Use this to write the "Next steps" section.');
	});

	it("asks the model to infer a next step when no goal is given", () => {
		const message = buildComposeUserMessage("[User]: hi", "");
		expect(message).toContain("No goal was given");
	});
});
