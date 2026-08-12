import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	extractServerRetryDelayMs,
	isRetryableAssistantError,
	MAX_SERVER_RETRY_DELAY_MS,
	type RetryPolicy,
	retryAssistantCall,
} from "../src/utils/retry.ts";
import googleFreeTier429 from "./fixtures/google-free-tier-429.json" with { type: "json" };

// The json-content-type branch of @google/genai does `JSON.stringify(await
// response.json())` on the same body the text branch double-stringifies, so it
// is derived from the captured fixture rather than hand-typed — a hand-spaced
// copy would claim byte-fidelity to a wire shape it does not have.
const perMinuteRequestsJsonShape = JSON.stringify(
	JSON.parse(JSON.parse(googleFreeTier429.perMinuteRequestsRaw).error.message),
);

const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});

	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	// The *Raw fixtures are byte-for-byte what pi's classifier receives from
	// real free-tier sessions (2026-08-11 pilot logs): @google/genai's
	// text-content-type branch double-stringifies, so the quotaId arrives as
	// \"quotaId\" — and every body carries the "billing details" boilerplate
	// that synthetic fixtures kept omitting.
	it("retries a real captured Gemini per-minute request throttle (double-encoded shape)", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: googleFreeTier429.perMinuteRequestsRaw }),
			),
		).toBe(true);
	});

	it("retries the same per-minute body in the json-content-type shape", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: perMinuteRequestsJsonShape,
				}),
			),
		).toBe(true);
	});

	it("keeps a real captured Gemini per-day exhaustion non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: googleFreeTier429.perDayRequestsRaw }),
			),
		).toBe(false);
	});

	it("keeps a real captured token-rate per-minute quota non-retryable (context cannot shrink)", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: googleFreeTier429.perMinuteInputTokensRaw }),
			),
		).toBe(false);
	});

	it("requires EVERY structured violation to be a request-rate per-minute quota", () => {
		const body = (ids: string[]) =>
			`429 quota exceeded, please check your plan and billing details. violations: [${ids
				.map((id) => `{"quotaId": "${id}"}`)
				.join(", ")}]`;
		const requests = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier";
		const tokens = "GenerateContentInputTokensPerModelPerMinute-FreeTier";
		for (const ids of [
			[requests, tokens],
			[tokens, requests],
		]) {
			expect(
				isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: body(ids) })),
			).toBe(false);
		}
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: body([requests]) })),
		).toBe(true);
	});

	it("lets a hard account-limit marker outrank a structured per-minute quotaId", () => {
		const errorMessage =
			'insufficient_quota: You exceeded your current quota. {"quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}';
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
	});

	it("lets a per-day violation outrank a co-occurring per-minute throttle", () => {
		const combined429 =
			'429 quota exceeded. violations: ["GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "GenerateRequestsPerDayPerProjectPerModel-FreeTier"]';
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: combined429 })),
		).toBe(false);
	});

	it("lets a hard account-limit marker outrank a co-occurring per-minute throttle", () => {
		for (const errorMessage of [
			'insufficient_quota: You exceeded your current quota ("GenerateRequestsPerMinutePerProjectPerModel-FreeTier")',
			"GoUsageLimitError: Monthly usage limit reached; PerMinute burst also throttled",
		]) {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		}
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("extractServerRetryDelayMs", () => {
	it("reads the full-precision delay out of a real captured per-minute 429", () => {
		// RetryInfo says "25s"; the prose says 25.309369594s. The longer one wins,
		// so the caller never wakes up inside the window Google stated.
		expect(extractServerRetryDelayMs(googleFreeTier429.perMinuteRequestsRaw)).toBe(26_310);
	});

	it("reads the same delay from the json-content-type shape of that body", () => {
		expect(extractServerRetryDelayMs(perMinuteRequestsJsonShape)).toBe(26_310);
	});

	it("outlasts the shipped default ladder on that body", () => {
		// The regression F12 named: 2s/4s/8s puts the last attempt at t=14s, all
		// three inside a 25.3s throttle window.
		const delay = extractServerRetryDelayMs(googleFreeTier429.perMinuteRequestsRaw);
		expect(delay).toBeGreaterThan(2_000 + 4_000 + 8_000);
	});

	it("reads sub-second and whole-second delays from the other captured bodies", () => {
		expect(extractServerRetryDelayMs(googleFreeTier429.perMinuteInputTokensRaw)).toBe(2_518);
		expect(extractServerRetryDelayMs(googleFreeTier429.perDayRequestsRaw)).toBe(18_961);
	});

	it("returns undefined when the error states no delay", () => {
		expect(extractServerRetryDelayMs(undefined)).toBeUndefined();
		expect(extractServerRetryDelayMs("")).toBeUndefined();
		expect(extractServerRetryDelayMs("overloaded_error")).toBeUndefined();
		expect(extractServerRetryDelayMs('{"retryDelay": "0s"}')).toBeUndefined();
	});

	it("ignores a seconds-shaped number sitting in unrelated prose", () => {
		// An unanchored unit read "8 steps" as 8s. Since the longest match across
		// both encodings wins, an incidental number could outrank the real RetryInfo.
		expect(extractServerRetryDelayMs("429: retry in 8 steps")).toBeUndefined();
		expect(extractServerRetryDelayMs('{"retryDelay": "3s"} — retry in 40 sessions')).toBe(4_000);
	});

	it("still reads the spelled-out unit", () => {
		expect(extractServerRetryDelayMs("Please retry in 12 sec")).toBe(13_000);
		expect(extractServerRetryDelayMs("Please retry in 5 seconds")).toBe(6_000);
	});

	it("does not clamp the longest delay a per-minute quota can legitimately state", () => {
		// Pilot 2 captured 58.758s from a live free-tier 429; padded, that is 59.758s
		// — 242ms under the old 60s ceiling. A slower window would have been clamped
		// down and retried from inside itself, the under-wait this floor exists to stop.
		expect(extractServerRetryDelayMs("Please retry in 58.758s")).toBe(59_758);
		expect(extractServerRetryDelayMs('{"retryDelay": "60s"}')).toBe(61_000);
	});

	it("clamps an implausible delay so a bad value cannot stall a turn", () => {
		expect(extractServerRetryDelayMs('{"retryDelay": "86400s"}')).toBe(MAX_SERVER_RETRY_DELAY_MS);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("floors the scheduled backoff at the delay the provider stated", async () => {
		// This loop backs compaction and is exported SDK surface, so it needs the
		// same floor as coding-agent's `_prepareRetry` — pinned here so the two
		// ladders cannot drift apart again. baseDelayMs is 0, so the whole delay is
		// the floor; the abort keeps the test from actually sleeping 26s.
		const controller = new AbortController();
		const onRetryScheduled = vi.fn(() => controller.abort());
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: googleFreeTier429.perMinuteRequestsRaw }),
		);

		const res = await retryAssistantCall(produce, enabled, controller.signal, { onRetryScheduled });

		expect(onRetryScheduled).toHaveBeenCalledWith(1, 3, 26_310, expect.any(String));
		expect(res.stopReason).toBe("aborted");
	});

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "terminated");
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
