import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { sleep, startServer, waitFor } from "./common.mjs";

const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAME_URL = process.env.GAME_URL ?? "http://localhost:5180/?test=1";
const PORT = Number(process.env.LAPTOP_DRIVER_PORT ?? 4801);

let browser = null;
let page = null;
let roomCode = null;
let phoneJoined = false;

function requireBooted() {
	if (!page) throw new Error("not booted — POST /boot first");
	return page;
}

const compact = (s) => ({
	sceneKey: s.sceneKey,
	x: Math.round(s.astronautX),
	y: Math.round(s.astronautY),
	won: s.won,
	respawnCount: s.respawnCount,
	enemyFrozen: s.enemyFrozen,
	platformCount: s.platformCount,
	darkZonePresent: s.darkZonePresent,
	phaseActive: s.phaseActive,
	lastCastPower: s.lastCastPower,
	lastCastBoosted: s.lastCastBoosted,
	lastSfxCue: s.lastSfxCue,
	unlockedPlanets: s.unlockedPlanets,
	completed: s.completed,
});

const snapshot = async () => compact(await requireBooted().evaluate(() => window.__constellation.getState()));

const routes = {
	"/boot": async () => {
		if (page) return { roomCode, phoneJoined, note: "already booted" };
		browser = await chromium.launch({ headless: true });
		const ctx = await browser.newContext({ viewport: { width: 960, height: 600 } });
		page = await ctx.newPage();
		// The room code lands in a `room-created` websocket frame (and on the
		// Phaser canvas, where no DOM reader can see it) — hook the frames.
		page.on("websocket", (ws) => {
			ws.on("framereceived", (frame) => {
				try {
					const payload = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
					const msg = JSON.parse(payload);
					if (msg.type === "room-created") roomCode = msg.roomCode;
					if (msg.type === "phone-joined") phoneJoined = true;
				} catch {
					// non-JSON frame — not ours
				}
			});
		});
		await page.goto(GAME_URL, { waitUntil: "domcontentloaded" });
		await page.waitForFunction(() => Boolean(window.__constellation), null, { timeout: 15_000 });
		const got = await waitFor(() => roomCode, 20_000);
		if (!got) throw new Error("no room-created frame in 20s — is the relay on :3081 up?");
		return { roomCode };
	},

	"/await-phone": async ({ timeoutMs = 240_000 } = {}) => {
		requireBooted();
		const ok = await waitFor(() => phoneJoined, timeoutMs, 250);
		if (!ok) return { phoneJoined: false, note: "timed out waiting for the phone to join" };
		// The Lobby lingers ~900ms after phone-joined before starting the Hub.
		await sleep(1_500);
		return { phoneJoined: true };
	},

	"/planet": async ({ id = "planet-1" } = {}) => {
		const p = requireBooted();
		await p.evaluate((pid) => window.__constellation.startPlanet(pid), id);
		await p.waitForFunction(() => window.__constellation.getState().sceneKey === "Planet", null, {
			timeout: 10_000,
		});
		return { state: await snapshot() };
	},

	"/state": async () => ({ state: await snapshot() }),

	/**
	 * One maneuver as a single in-page loop — all timing runs in the browser, so
	 * one HTTP call buys a whole move no matter how slow the caller's turns are.
	 * `hop` bunny-hops on a fixed cadence; `jumpAtX` jumps exactly once when
	 * crossing that x (how a human takes a gap: jump at the lip, not on a timer).
	 * Stops on: won, a respawn (death), reaching untilX, or ms elapsed.
	 */
	"/move": async ({ dir = "none", ms = 2_000, hop = false, jumpAtX = null, untilX = null, maxMs = 15_000 } = {}) => {
		const p = requireBooted();
		if (!["right", "left", "none"].includes(dir)) throw new Error(`bad dir "${dir}"`);
		const budget = Math.min(Number(ms) || 0, maxMs);
		const result = await p.evaluate(
			async (opts) => {
				const b = window.__constellation;
				const pause = (t) => new Promise((r) => setTimeout(r, t));
				const start = b.getState();
				b.resetInput();
				if (opts.dir === "right") b.input.right = true;
				if (opts.dir === "left") b.input.left = true;
				const t0 = performance.now();
				let lastHop = -1_000;
				let jumped = false;
				const events = [];
				let s = start;
				for (;;) {
					await pause(60);
					s = b.getState();
					const t = performance.now() - t0;
					if (opts.hop && t - lastHop > 420) {
						b.input.jump = true;
						setTimeout(() => {
							b.input.jump = false;
						}, 120);
						lastHop = t;
					}
					if (
						opts.jumpAtX != null &&
						!jumped &&
						((opts.dir === "right" && s.astronautX >= opts.jumpAtX) ||
							(opts.dir === "left" && s.astronautX <= opts.jumpAtX))
					) {
						b.input.jump = true;
						setTimeout(() => {
							b.input.jump = false;
						}, 120);
						jumped = true;
						events.push("jumped");
					}
					if (s.won) {
						events.push("won");
						break;
					}
					if (s.respawnCount > start.respawnCount) {
						events.push("respawned");
						break;
					}
					if (
						opts.untilX != null &&
						((opts.dir === "right" && s.astronautX >= opts.untilX) ||
							(opts.dir === "left" && s.astronautX <= opts.untilX))
					) {
						events.push("reached-x");
						break;
					}
					if (t >= opts.budget) {
						events.push("time-up");
						break;
					}
				}
				b.resetInput();
				return {
					events,
					before: { x: Math.round(start.astronautX), y: Math.round(start.astronautY) },
					after: s,
					elapsedMs: Math.round(performance.now() - t0),
				};
			},
			{ dir, hop, jumpAtX, untilX, budget },
		);
		return { events: result.events, before: result.before, elapsedMs: result.elapsedMs, state: compact(result.after) };
	},

	"/screenshot": async ({ name = "shot" } = {}) => {
		const p = requireBooted();
		const dir = path.join(HARNESS_DIR, "reports", "shots");
		await mkdir(dir, { recursive: true });
		const file = path.join(dir, `${Date.now()}-laptop-${name.replace(/[^\w-]/g, "_")}.png`);
		await p.screenshot({ path: file });
		return { file };
	},

	"/shutdown": async () => {
		await browser?.close().catch(() => {});
		setTimeout(() => process.exit(0), 250);
		return { ok: true, note: "laptop driver exiting" };
	},
};

startServer("laptop-driver", PORT, routes);
