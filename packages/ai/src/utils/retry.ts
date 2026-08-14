import type { AssistantMessage } from "../types.ts";

function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

const NON_RETRYABLE_ACCOUNT_LIMIT_PATTERNS: readonly string[] = [
	// OpenCode Go/free-tier limits returned as 429 JSON error types by OpenCode's
	// Zen API. These are subscription/account limits, not transient throttles.
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go subscription-limit text asks users to enable available-balance
	// usage after rolling/weekly/monthly limits are reached.
	"Monthly usage limit reached",
	"available balance",

	// Account/budget/billing exhaustion. `insufficient_quota` is OpenAI's
	// quota/billing error code; the other strings cover common gateway wording.
	"insufficient_quota",
	"out of budget",
	"billing",
];

// Hard account/billing markers alone — checked before the Google per-minute
// carve-out in isRetryableAssistantError, so a terminal marker anywhere in the
// message always wins over a co-occurring per-minute quota hint.
const NON_RETRYABLE_ACCOUNT_LIMIT_PATTERN = buildProviderErrorPattern(NON_RETRYABLE_ACCOUNT_LIMIT_PATTERNS);

// The same markers minus the bare "billing" substring, for messages that carry
// a structured Google quotaId: every Gemini quota 429 — transient per-minute
// throttles included — opens with "please check your plan and billing details",
// so inside that branch "billing" is boilerplate, not an account signal.
const NON_RETRYABLE_ACCOUNT_LIMIT_SANS_BILLING_PATTERN = buildProviderErrorPattern(
	NON_RETRYABLE_ACCOUNT_LIMIT_PATTERNS.filter((p) => p !== "billing"),
);

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	...NON_RETRYABLE_ACCOUNT_LIMIT_PATTERNS,
	// Generic quota-exhaustion wording (Google free-tier tiers phrase both their
	// per-day caps and their token-rate caps this way).
	"quota exceeded",
]);

const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// Generic provider load, HTTP status, and server-side transient failures.
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// Wrapper/provider text for transient upstream failures, including OpenRouter
	// "Provider returned error" responses (#2264).
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// Network, proxy, and fetch transport failures. This includes OpenAI Codex
	// raw-fetch failures such as "upstream connect", "connection refused", and
	// "reset before headers" (#733), plus OpenRouter connection drops (#3317).
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket transports can report close/error text instead of HTTP/fetch text.
	"websocket.?closed",
	"websocket.?error",

	// Premature stream endings from SDKs and transports. Anthropic can throw
	// "stream ended without ..." and "Anthropic stream ended before message_stop"
	// (#4433); Bedrock/Smithy can throw an HTTP/2 no-response error (#3594).
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// Provider-requested retry delay cap failures should flow through the outer
	// retry policy so callers can surface/abort the backoff (#1123).
	"retry delay",

	// Explicit retry guidance emitted mid-stream by OpenAI Responses and Bedrock
	// stream exceptions (#6019).
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// gRPC based providers (e.g. NVIDIA NIM)
	"ResourceExhausted",
]);

/**
 * Retry policy: bounded attempts with exponential backoff (`baseDelayMs * 2^(attempt-1)`),
 * floored at any retry delay the provider stated in the error itself.
 * Matches `settings.retry` (`enabled`, `maxRetries`, `baseDelayMs`) in coding-agent; kept
 * here so the classifier and the policy-driven retry loop live together and stay reusable
 * by the SDK and other callers.
 */
export interface RetryPolicy {
	enabled: boolean;
	/** Max retry attempts (0 = no retries). The initial call never counts as a retry. */
	maxRetries: number;
	/**
	 * Base delay in ms. Per-attempt delay is `baseDelayMs * 2^(attempt-1)`, floored at any
	 * retry delay the provider stated (clamped to {@link MAX_SERVER_RETRY_DELAY_MS}) — so
	 * this does not bound the wait on its own, not even at `baseDelayMs: 0`.
	 */
	baseDelayMs: number;
}

/** Optional callbacks emitted by {@link retryAssistantCall} around each retry. */
export interface RetryCallbacks {
	/** Emitted before the backoff sleep of each retry attempt (1-indexed). */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** Emitted after the backoff sleep, immediately before the retried call starts. */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** Emitted once when the loop ends: success if a later call completed normally. */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * Run a single assistant-producing call with bounded retry on transient errors.
 *
 * Behavior:
 * - A successful response is returned immediately. Aborts are terminal and never
 *   retried, but reported as unsuccessful if they happen after a retry was scheduled.
 *   Aborts during the backoff sleep are normalized to an aborted `AssistantMessage`
 *   too, so callers do not need to care when cancellation happened.
 * - A non-retryable error (per {@link isRetryableAssistantError}, including quota/
 *   billing exhaustion) is returned immediately so deterministic errors fail fast.
 * - Otherwise retries up to `maxRetries` times with exponential backoff, emitting
 *   `onRetryScheduled` before each sleep, `onRetryAttemptStart` after each sleep before
 *   the retried call starts, and `onRetryFinished` once at the end (whether the loop
 *   ends in success, exhausted retries, or an aborted backoff).
 *
 * When `policy` is undefined or disabled, the first response is returned unchanged
 * (equivalent to calling `produce()` directly).
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// Abort: terminal but not successful. Never retry an aborted message.
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// Success: non-error, non-abort responses return as-is.
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// Non-retryable, or budget exhausted: return the final error message.
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		// Same floor as the agent-turn loop in coding-agent's `_prepareRetry`: this
		// loop shares its policy and its classifier, so an unfloored ladder here
		// would still burn every compaction retry inside a throttle window the
		// provider already told us to wait out.
		const delayMs = Math.max(
			policy!.baseDelayMs * 2 ** (attempt - 1),
			extractServerRetryDelayMs(response.errorMessage) ?? 0,
		);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// Normalize aborts during retry backoff to the same AssistantMessage shape as
		// provider stream aborts, so callers do not need to care when cancellation happened.
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error, so callers can decide if the last assistant turn should be
 * restarted.
 *
 * This does not implement retry policy. Callers should first handle context
 * overflow separately, then apply their own retry budget, backoff, and reporting
 * before restarting the assistant turn.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	// Google quotaIds are authoritative over the prose around them: every Gemini
	// quota 429 — transient per-minute throttles included — opens with "please
	// check your plan and billing details", so the account-limit and "quota
	// exceeded" patterns below would misclassify all of them as terminal. The
	// extraction is escape-tolerant because @google/genai delivers TWO shapes:
	// a json-content-type body ("quotaId": "…") and, for text bodies, a
	// double-stringified one (\"quotaId\": \"…\") — the captured pilot logs are
	// all the second shape. Retryable ⇔ EVERY violation is a per-minute quota,
	// no per-day violation rides along, and no hard account marker
	// (insufficient_quota, usage-limit text) appears. Request-rate windows clear
	// on their own inside the rolling minute. A token-rate quota
	// (…InputTokensPerModelPerMinute…) is ambiguous between two cases nothing in
	// the error body can distinguish: a rolling window filled by *earlier*
	// requests (clears on its own; every captured pilot failure — four seats
	// killed fail-fast with the server saying "Please retry in 39.2s" — is this
	// case) and a single request whose context alone exceeds the cap (can never
	// succeed). A stated RetryInfo delay does NOT discriminate: Google attaches
	// one even to per-day exhaustion (the captured per-day fixture states 17s
	// against a cap that clears at midnight). So both token-rate cases retry:
	// the wrong guess on a truly oversized request costs a bounded, abortable
	// backoff (maxRetries × ≤ MAX_SERVER_RETRY_DELAY_MS), where the old
	// fail-fast killed the whole session on the common rolling-window case.
	const quotaIds = [...errorMessage.matchAll(/\\?"quotaId\\?":\s*\\?"([^"\\]+)/g)].map((m) => m[1]);
	if (quotaIds.length > 0) {
		if (NON_RETRYABLE_ACCOUNT_LIMIT_SANS_BILLING_PATTERN.test(errorMessage)) return false;
		if (/PerDay/.test(errorMessage)) return false;
		// Deliberately any per-minute family — request-rate
		// (GenerateRequests…PerMinute…) and token-rate
		// (…InputTokensPerModelPerMinute…) ids both match, as will future
		// per-minute quota families; the per-day and account guards above are
		// what keep this from over-accepting.
		return quotaIds.every((id) => /PerMinute/.test(id));
	}
	// Prose-only fallback (no structured quotaId): same precedence, hard
	// account/billing markers and per-day mentions outrank the per-minute hint.
	if (NON_RETRYABLE_ACCOUNT_LIMIT_PATTERN.test(errorMessage)) return false;
	if (/PerDay/.test(errorMessage)) return false;
	if (/GenerateRequests\w*PerMinute/.test(errorMessage)) return true;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/**
 * Upper bound on a server-stated retry delay callers should honor.
 *
 * Sized off what a *legitimate* delay can be, not off a round number. The
 * extractor only ever runs on errors {@link isRetryableAssistantError} already
 * accepted, which for Google means a per-minute quota (request-rate or
 * token-rate) — windows that by definition close inside a
 * rolling 60s — so 60s plus
 * {@link SERVER_RETRY_DELAY_PAD_MS} is the longest honest value. A 60s ceiling
 * left no room for it: a captured pilot 429 stated 58.758s, which pads to
 * 59.758s and cleared the old clamp by 242ms. Anything slower would have been
 * silently clamped down and retried inside the window — the exact under-wait
 * this floor exists to prevent. 90s clears every real per-minute delay while
 * still capping a malformed or hostile value at 90s per attempt (4.5 min across
 * the default 3 retries), and the backoff sleep honors the abort signal
 * throughout, so a stalled turn is always cancellable.
 */
export const MAX_SERVER_RETRY_DELAY_MS = 90_000;

/**
 * A throttle window Google states to the second is easy to under-wait: a
 * request-rate 429 says "Please retry in 25.3s" while a `2s * 2^(n-1)` ladder
 * spends its whole budget by t=14s. Retrying inside the stated window cannot
 * succeed, so callers floor their backoff at what the provider asked for.
 */
const SERVER_RETRY_DELAY_PATTERNS: readonly RegExp[] = [
	// google.rpc.RetryInfo, in both @google/genai body shapes (json branch
	// `"retryDelay": "25s"`, text branch double-stringified `\"retryDelay\": \"25s\"`).
	/\\?"retryDelay\\?":\s*\\?"(\d+(?:\.\d+)?)s/g,
	// The same delay in the prose Google puts in `error.message`, at full
	// precision: "Please retry in 25.309369594s." The unit is anchored so the
	// pattern cannot read a seconds count out of unrelated prose — an
	// unanchored `s` also matches "retry in 8 steps", and since the longest
	// match across both patterns wins, that number would outrank the
	// authoritative RetryInfo value.
	/retry in (\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/gi,
];

/** Padding over the stated delay — retrying on the exact boundary still throttles. */
const SERVER_RETRY_DELAY_PAD_MS = 1_000;

/**
 * Extracts the delay a provider asked the caller to wait before retrying, in ms,
 * or `undefined` when the error states none. Both known encodings are scanned and
 * the longest wins (`RetryInfo` truncates to whole seconds; the prose carries the
 * fraction), then the result is padded and clamped to {@link MAX_SERVER_RETRY_DELAY_MS}
 * so a malformed or hostile value cannot stall a turn indefinitely.
 */
export function extractServerRetryDelayMs(errorMessage: string | undefined): number | undefined {
	if (!errorMessage) return undefined;
	let seconds = 0;
	for (const pattern of SERVER_RETRY_DELAY_PATTERNS) {
		for (const match of errorMessage.matchAll(pattern)) {
			const parsed = Number.parseFloat(match[1]);
			if (Number.isFinite(parsed) && parsed > seconds) seconds = parsed;
		}
	}
	if (seconds <= 0) return undefined;
	return Math.min(Math.ceil(seconds * 1000) + SERVER_RETRY_DELAY_PAD_MS, MAX_SERVER_RETRY_DELAY_MS);
}
