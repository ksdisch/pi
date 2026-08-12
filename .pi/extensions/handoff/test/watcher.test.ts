import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODE,
	DEFAULT_THRESHOLD_PERCENT,
	evaluateWatch,
	MODE_ENV,
	REARM_MARGIN_PERCENT,
	readWatchConfig,
	THRESHOLD_ENV,
	type WatchConfig,
} from "../watcher.ts";

function usage(percent: number | null): ContextUsage {
	return { tokens: percent === null ? null : 1000, contextWindow: 200_000, percent };
}

const CONFIG: WatchConfig = { mode: "propose", thresholdPercent: 80 };

describe("readWatchConfig", () => {
	// The default is deliberately the non-modal one: a dialog disposes any open selector,
	// blocks a quit requested mid-run, and eats the next scripted Enter.
	it("defaults to writing the note at 80% with nothing set", () => {
		expect(readWatchConfig({})).toEqual({
			config: { mode: "auto", thresholdPercent: DEFAULT_THRESHOLD_PERCENT },
			warnings: [],
		});
		expect(DEFAULT_MODE).toBe("auto");
	});

	it.each(["off", "notify", "propose", "auto"] as const)("accepts mode %s", (mode) => {
		expect(readWatchConfig({ [MODE_ENV]: mode }).config.mode).toBe(mode);
	});

	it("accepts a mode with stray case and whitespace, as a shell would hand it over", () => {
		expect(readWatchConfig({ [MODE_ENV]: " Auto \n" }).config.mode).toBe("auto");
	});

	// A typo'd env var that silently falls back is the failure mode this guards: the user
	// believes the watcher is on, and nothing ever tells them it is not.
	it("warns and keeps the default on an unknown mode", () => {
		const result = readWatchConfig({ [MODE_ENV]: "enabled" });
		expect(result.config.mode).toBe(DEFAULT_MODE);
		expect(result.warnings).toEqual([
			`${MODE_ENV}="enabled" is not one of off, notify, propose, auto; using "${DEFAULT_MODE}".`,
		]);
	});

	it("reads a numeric threshold, including a fractional one", () => {
		expect(readWatchConfig({ [THRESHOLD_ENV]: "62.5" }).config.thresholdPercent).toBe(62.5);
	});

	it.each(["0", "-5", "101", "eighty", ""])("warns and keeps the default on threshold %j", (raw) => {
		const result = readWatchConfig({ [THRESHOLD_ENV]: raw });
		expect(result.config.thresholdPercent).toBe(DEFAULT_THRESHOLD_PERCENT);
		// An empty value is an unset value, not a mistake worth reporting.
		expect(result.warnings).toHaveLength(raw === "" ? 0 : 1);
	});

	it("reports both problems at once", () => {
		expect(readWatchConfig({ [MODE_ENV]: "yes", [THRESHOLD_ENV]: "wat" }).warnings).toHaveLength(2);
	});
});

describe("evaluateWatch", () => {
	it("acts once usage reaches the threshold", () => {
		expect(evaluateWatch(usage(80), CONFIG, true)).toEqual({ act: true, armed: false, percent: 80 });
	});

	it("stays quiet below the threshold", () => {
		expect(evaluateWatch(usage(79.9), CONFIG, true)).toEqual({ act: false, armed: true });
	});

	it("does not act twice on one crossing", () => {
		expect(evaluateWatch(usage(92), CONFIG, false)).toEqual({ act: false, armed: false });
	});

	// Usage hovering either side of the line across turns must not re-propose every settle.
	it("does not re-arm just below the threshold", () => {
		expect(evaluateWatch(usage(75), CONFIG, false)).toEqual({ act: false, armed: false });
	});

	it("re-arms once usage falls a full margin below, as a compaction makes it", () => {
		const rearmed = evaluateWatch(usage(CONFIG.thresholdPercent - REARM_MARGIN_PERCENT), CONFIG, false);
		expect(rearmed).toEqual({ act: false, armed: true });
		expect(evaluateWatch(usage(88), CONFIG, rearmed.armed).act).toBe(true);
	});

	// null between a compaction and the next assistant response: pi cannot price the new
	// context yet. Unknown is not "low", so the armed flag must survive untouched.
	it.each([
		["unknown usage", usage(null)],
		["no usage at all", undefined],
	])("holds its state on %s", (_label, value) => {
		expect(evaluateWatch(value, CONFIG, false)).toEqual({ act: false, armed: false });
		expect(evaluateWatch(value, CONFIG, true)).toEqual({ act: false, armed: true });
	});

	it("never acts when the mode is off", () => {
		expect(evaluateWatch(usage(99), { mode: "off", thresholdPercent: 80 }, true)).toEqual({ act: false, armed: true });
	});

	it("acts immediately on a session that starts over the line", () => {
		expect(evaluateWatch(usage(95), CONFIG, true).act).toBe(true);
	});
});
