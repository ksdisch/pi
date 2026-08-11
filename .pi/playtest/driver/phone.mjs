import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer, waitFor } from "./common.mjs";

const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PHONE_URL = process.env.PHONE_URL ?? "http://localhost:5180/phone.html";
const PORT = Number(process.env.PHONE_DRIVER_PORT ?? 4802);

const POWER_LABELS = {
	"freeze-stars": "Freeze Stars",
	"summon-platform": "Summon Platform",
	illuminate: "Illuminate",
	"phase-dash": "Phase Dash",
};

let browser = null;
let page = null;

function requireJoined() {
	if (!page) throw new Error("no phone page — POST /join first");
	return page;
}

/** Classify the current phone screen from its visible text. */
const readScreen = () =>
	requireJoined().evaluate(() => {
		const text = document.body.innerText;
		let screen = "unknown";
		if (document.querySelector('input[placeholder="ABCDEF"]')) screen = "join";
		else if (text.includes("Cast!")) screen = "cast-feedback";
		else if (/Freeze Stars · \d/.test(text)) screen = "puzzle-freeze-stars";
		else if (/Summon Platform · /.test(text)) screen = "puzzle-summon-platform";
		else if (/Illuminate · \d/.test(text)) screen = "puzzle-illuminate";
		else if (/spellbook/i.test(text)) screen = "spellbook";
		else if (text.includes("The link to the laptop dropped")) screen = "disconnected";
		const star = text.match(/★ (\d+)/);
		return {
			screen,
			stardust: star ? Number(star[1]) : null,
			excerpt: text.replace(/\n{2,}/g, "\n").trim().slice(0, 700),
		};
	});

/**
 * In-page QuickMath executor: 3 problems / 30s. Reads each `a op b`, computes,
 * submits; advances on the `Freeze Stars · N/3` header so a duplicate problem
 * can't stall it. ops are '+', '−' (U+2212), '×'.
 */
const runQuickMath = () =>
	requireJoined().evaluate(async () => {
		const pause = (t) => new Promise((r) => setTimeout(r, t));
		const transcript = [];
		const t0 = Date.now();
		let lastAnswered = 0;
		while (Date.now() - t0 < 32_000) {
			const text = document.body.innerText;
			if (text.includes("Cast!")) return { solved: true, transcript, elapsedMs: Date.now() - t0 };
			const header = text.match(/Freeze Stars · (\d+)\/(\d+)/);
			if (!header) {
				if (/spellbook/i.test(text))
					return { solved: false, transcript, note: "back at spellbook without Cast! (timed out?)" };
				await pause(100);
				continue;
			}
			const idx = Number(header[1]);
			if (idx === lastAnswered) {
				await pause(80);
				continue;
			}
			let prob = null;
			for (const div of document.querySelectorAll("div")) {
				if (div.children.length) continue;
				const m = div.textContent.trim().match(/^(\d+)\s*([+−×])\s*(\d+)$/);
				if (m) {
					prob = { a: Number(m[1]), op: m[2], b: Number(m[3]) };
					break;
				}
			}
			const input = document.querySelector('input[type="number"]');
			if (!prob || !input) {
				await pause(80);
				continue;
			}
			const answer = prob.op === "+" ? prob.a + prob.b : prob.op === "−" ? prob.a - prob.b : prob.a * prob.b;
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
			setter.call(input, String(answer));
			input.dispatchEvent(new Event("input", { bubbles: true }));
			await pause(70);
			const submit = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Submit");
			if (!submit || submit.disabled) {
				await pause(80);
				continue;
			}
			submit.click();
			transcript.push({ problem: `${prob.a} ${prob.op} ${prob.b}`, answer });
			lastAnswered = idx;
			await pause(150);
		}
		return { solved: document.body.innerText.includes("Cast!"), transcript, note: "deadline", elapsedMs: Date.now() - t0 };
	});

/**
 * In-page Trivia executor: 3 questions / 30s, wrong answer resets the round.
 * Answers come from the question pool the page itself can serve — the Vite dev
 * server transpiles `triviaLogic.ts` on demand, so `import()` needs no game
 * change and no source parsing. Unknown questions fall back to option A.
 */
const runTrivia = () =>
	requireJoined().evaluate(async () => {
		const pause = (t) => new Promise((r) => setTimeout(r, t));
		let pool = [];
		let poolError = null;
		try {
			const mod = await import("/src/phone/components/puzzles/triviaLogic.ts");
			pool = mod.QUESTIONS ?? [];
		} catch (err) {
			poolError = String(err);
		}
		const transcript = [];
		let resets = 0;
		const t0 = Date.now();
		while (Date.now() - t0 < 32_000) {
			const text = document.body.innerText;
			if (text.includes("Cast!")) return { solved: true, transcript, resets, poolError, elapsedMs: Date.now() - t0 };
			if (!/Illuminate · \d+\/\d+/.test(text)) {
				if (/spellbook/i.test(text))
					return { solved: false, transcript, resets, poolError, note: "back at spellbook without Cast!" };
				await pause(100);
				continue;
			}
			if (text.includes("Try again!")) {
				resets++;
				await pause(650);
				continue;
			}
			const options = [...document.querySelectorAll("button")].filter(
				(b) => !["Cancel", "Submit"].includes(b.textContent.trim()),
			);
			if (!options.length) {
				await pause(80);
				continue;
			}
			const entry = pool.find((q) => text.includes(q.prompt));
			let pick = 0;
			let known = false;
			if (entry) {
				const correctText = entry.options[entry.correctIndex];
				const i = options.findIndex((b) => b.textContent.includes(correctText));
				if (i !== -1) {
					pick = i;
					known = true;
				}
			}
			const prevHeader = (text.match(/Illuminate · \d+\/\d+/) ?? [])[0];
			options[pick].click();
			transcript.push({
				question: entry ? entry.prompt : "(not in pool)",
				picked: options[pick].textContent.trim().slice(0, 80),
				known,
			});
			const t1 = Date.now();
			while (Date.now() - t1 < 1_500) {
				const now = document.body.innerText;
				if (now.includes("Cast!") || now.includes("Try again!")) break;
				if ((now.match(/Illuminate · \d+\/\d+/) ?? [])[0] !== prevHeader) break;
				await pause(60);
			}
		}
		return {
			solved: document.body.innerText.includes("Cast!"),
			transcript,
			resets,
			poolError,
			note: "deadline",
			elapsedMs: Date.now() - t0,
		};
	});

/**
 * In-page TapSequence executor: watch the demo (a lit cell's inline background
 * serializes to `rgb(...)`, unlit to `rgba(...)`; the fail flash lights all
 * four at once and is skipped), then tap the sequence back. The sequence is
 * memoized per puzzle mount, so a mid-demo attach that under-observes just
 * waits out the timer and reports a mismatch instead of guessing.
 */
const runTapSequence = () =>
	requireJoined().evaluate(async () => {
		const pause = (t) => new Promise((r) => setTimeout(r, t));
		const cells = () => [...document.querySelectorAll('button[aria-label^="cell "]')];
		const litIndex = (cs) => {
			const lit = cs.map((c, i) => [c, i]).filter(([c]) => (c.style.background || "").startsWith("rgb("));
			return lit.length === 1 ? lit[0][1] : lit.length > 1 ? "fail-flash" : -1;
		};
		const attempts = [];
		const t0 = Date.now();
		while (Date.now() - t0 < 23_000) {
			const text = document.body.innerText;
			if (text.includes("Cast!")) return { solved: true, attempts, elapsedMs: Date.now() - t0 };
			if (/spellbook/i.test(text)) return { solved: false, attempts, note: "back at spellbook without Cast!" };
			const cs = cells();
			if (cs.length !== 4) {
				await pause(80);
				continue;
			}
			if (!cs[0].disabled) {
				await pause(100);
				continue;
			}
			// demo (or fail flash) in progress — observe until input mode opens
			let seq = [];
			let prev = -1;
			const demoT0 = Date.now();
			while (Date.now() - demoT0 < 9_000) {
				const cur = cells();
				if (!cur.length || !cur[0].disabled) break;
				const lit = litIndex(cur);
				if (lit === "fail-flash") {
					seq = [];
					prev = -1;
				} else {
					if (lit !== -1 && prev === -1) seq.push(lit);
					prev = lit;
				}
				await pause(30);
			}
			if (!seq.length) {
				await pause(100);
				continue;
			}
			const total = Number((document.body.innerText.match(/Summon Platform · (\d+)\/(\d+)/) ?? [])[2] ?? 0);
			if (total && seq.length !== total) {
				attempts.push({ observed: seq.map((i) => i + 1), mismatch: `saw ${seq.length}, expected ${total}` });
				await pause(300);
				continue;
			}
			await pause(250);
			for (const i of seq) {
				const cur = cells();
				if (!cur[i] || cur[i].disabled) break;
				cur[i].click();
				await pause(160);
			}
			attempts.push({ observed: seq.map((i) => i + 1) });
			await pause(450);
		}
		return { solved: document.body.innerText.includes("Cast!"), attempts, note: "deadline", elapsedMs: Date.now() - t0 };
	});

const routes = {
	"/join": async ({ code } = {}) => {
		if (!code || !/^[A-Za-z]{6}$/.test(code)) throw new Error(`bad room code ${JSON.stringify(code)} — expected 6 letters`);
		// Guard on `page` (not `browser`) and tear down on failure, so a crash
		// between launch and newPage can't leave a browser without a page that
		// every later /join trips over.
		if (!page) {
			try {
				browser ??= await chromium.launch({ headless: true });
				const ctx = await browser.newContext({ viewport: { width: 390, height: 720 } });
				page = await ctx.newPage();
			} catch (err) {
				await browser?.close().catch(() => {});
				browser = null;
				page = null;
				throw err;
			}
		}
		await page.goto(PHONE_URL, { waitUntil: "domcontentloaded" });
		await page.getByPlaceholder("ABCDEF").fill(code.toUpperCase());
		await page.getByRole("button", { name: "Join" }).click();
		const joined = await waitFor(async () => {
			const r = await readScreen();
			return r.screen === "spellbook" ? r : null;
		}, 12_000);
		if (joined) return joined;
		const r = await readScreen();
		return { ...r, note: "did not reach the spellbook — check the excerpt for the error shown" };
	},

	"/read": async () => readScreen(),

	"/solve": async ({ power } = {}) => {
		const label = POWER_LABELS[power];
		if (!label) throw new Error(`unknown power ${JSON.stringify(power)} — one of ${Object.keys(POWER_LABELS).join(", ")}`);
		if (power === "phase-dash") throw new Error("phase-dash (Phase Align) is not supported by the v1 pilot driver");
		const p = requireJoined();
		// let a lingering cast-feedback card auto-return to the spellbook first
		const ready = await waitFor(async () => (await readScreen()).screen === "spellbook", 4_000, 300);
		if (!ready) {
			const r = await readScreen();
			throw new Error(`not at spellbook (screen=${r.screen}) — /read to see what's on screen`);
		}
		await p.locator("button", { hasText: label }).first().click();
		const started = Date.now();
		const result =
			power === "freeze-stars" ? await runQuickMath() : power === "illuminate" ? await runTrivia() : await runTapSequence();
		// Return the moment the cast lands — freeze lasts ~3s and the laptop needs
		// every one of them. The next /solve's pre-wait absorbs the feedback card.
		return { power, ...result, totalMs: Date.now() - started, now: await readScreen() };
	},

	"/screenshot": async ({ name = "shot" } = {}) => {
		const p = requireJoined();
		const dir = path.join(HARNESS_DIR, "reports", "shots");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${Date.now()}-phone-${name.replace(/[^\w-]/g, "_")}.png`);
		await p.screenshot({ path: file });
		return { file };
	},

	"/shutdown": async () => {
		await browser?.close().catch(() => {});
		setTimeout(() => process.exit(0), 250);
		return { ok: true, note: "phone driver exiting" };
	},
};

startServer("phone-driver", PORT, routes);
