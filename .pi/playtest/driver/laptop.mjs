import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { closeForVideo, contextOptions, launchOptions, saveVideo, sleep, startServer, waitFor } from "./common.mjs";

const HARNESS_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GAME_URL = process.env.GAME_URL ?? "http://localhost:5180/?test=1";
const PORT = Number(process.env.LAPTOP_DRIVER_PORT ?? 4801);
const VIEWPORT = { width: 960, height: 600 };
/**
 * Ceiling on a single maneuver, independent of what the caller asks for. The
 * driver runs one command at a time (common.mjs serializes them), so an
 * over-long /move blocks every later queued command. (/shutdown is the one
 * exception — common.mjs deliberately runs it off the chain.)
 */
const MOVE_HARD_CAP_MS = 15_000;
/**
 * Armed moves: how long /move will hold a pre-committed maneuver waiting for
 * its trigger — the default AND the ceiling; callers can only tighten it, like
 * maxMs. It covers a partner turn plus one per-minute 429 backoff (~60s stated
 * + pad), and it must stay under the curl deadline the player prompt hands out
 * (120s): a hold that outlives its client wedges the seat's serial command
 * chain behind a call nobody is waiting on.
 */
const ARM_TIMEOUT_MAX_MS = 90_000;
/**
 * Fixed pause between an armed trigger firing and the move starting. Models a
 * poised human's reaction (~200ms) and is deliberately not caller-tunable: the
 * harness plays at human anticipation speed, never frame-perfect script speed
 * (DESIGN.md honesty rules).
 */
const ARM_REACTION_MS = 200;

let browser = null;
let page = null;
let roomCode = null;
let phoneJoined = false;
let booted = false;

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
		// `booted` flips only on full success — a failed boot tears down and lets
		// the caller retry /boot instead of wedging on "already booted".
		if (booted) return { roomCode, phoneJoined, note: "already booted" };
		try {
			browser = await chromium.launch(launchOptions());
			const ctx = await browser.newContext(contextOptions(VIEWPORT));
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
		} catch (err) {
			// The context created above already has a recording in flight. Close it
			// first so Playwright finalizes the webm, then flush it under a name that
			// says what it is — going straight to `browser.close()` strands it as
			// `page@<hash>.webm` (see `closeForVideo` in common.mjs). Repeated failed
			// boots overwrite the file; the last failure is the one worth watching.
			const video = page?.video() ?? null;
			// Bounded: /boot runs on the serial command chain and every other wait on
			// this path has a cap — a close that hangs finalizing the webm must not
			// wedge every later command behind a boot that already failed.
			await Promise.race([closeForVideo(page), sleep(5_000)]);
			await saveVideo(video, "laptop-boot-failed");
			await browser?.close().catch(() => {});
			browser = null;
			page = null;
			roomCode = null;
			phoneJoined = false;
			throw err;
		}
		booted = true;
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
	 *
	 * `arm` pre-commits the whole maneuver on a partner's cast: the astronaut
	 * stands still until the trigger fires — "freeze" = enemyFrozen is on,
	 * "platform" = platformCount rises above its arm-time value — then waits one
	 * human reaction (ARM_REACTION_MS) and runs the move. The wait aborts without
	 * moving on death, win, or arm.timeoutMs; an armed player is still a
	 * stationary target, and that exposure is playtest data, not a bug.
	 */
	"/move": async ({
		dir = "none",
		ms = 2_000,
		hop = false,
		jumpAtX = null,
		untilX = null,
		maxMs = MOVE_HARD_CAP_MS,
		arm = null,
	} = {}) => {
		const p = requireBooted();
		if (!["right", "left", "none"].includes(dir)) throw new Error(`bad dir "${dir}"`);
		if (arm != null && !["freeze", "platform"].includes(arm.on)) {
			throw new Error(`bad arm.on "${arm?.on}" — use "freeze" or "platform"`);
		}
		// `maxMs` is caller-supplied, so it can only tighten the cap, never raise it.
		const budget = Math.min(Number(ms) || 0, Number(maxMs) || MOVE_HARD_CAP_MS, MOVE_HARD_CAP_MS);
		// Same rule for arm.timeoutMs against its ceiling; the reaction delay is
		// pinned here so a caller can never tune it down to script speed.
		const armOpts =
			arm == null
				? null
				: {
						on: arm.on,
						timeoutMs: Math.min(Number(arm.timeoutMs) || ARM_TIMEOUT_MAX_MS, ARM_TIMEOUT_MAX_MS),
						reactionMs: ARM_REACTION_MS,
					};
		const result = await p.evaluate(
			async (opts) => {
				const b = window.__constellation;
				const pause = (t) => new Promise((r) => setTimeout(r, t));
				let start = b.getState();
				const before = { x: Math.round(start.astronautX), y: Math.round(start.astronautY) };
				b.resetInput();
				const events = [];
				let armedForMs = null;
				if (opts.arm) {
					// "freeze" fires on the level (a human who sees the enemy already
					// frozen just goes). "platform" fires on the count rising above the
					// LOWEST count seen since arming, not a fixed arm-time baseline: the
					// game caps live platforms at one, so a fixed baseline of 1 could
					// never fire again — expiry drops the count to 0 and a fresh cast
					// only returns it to 1. The floor tracks the expiry down.
					let floorPlatforms = start.platformCount;
					const ta = performance.now();
					for (;;) {
						await pause(60);
						const s = b.getState();
						const t = performance.now() - ta;
						const fired = opts.arm.on === "freeze" ? s.enemyFrozen : s.platformCount > floorPlatforms;
						if (fired) {
							events.push("arm-fired");
							armedForMs = Math.round(t);
							await pause(opts.arm.reactionMs);
							// Re-baseline so the move loop's respawn check measures the
							// move, not deaths that already aborted the wait.
							start = b.getState();
							break;
						}
						if (s.won || s.respawnCount > start.respawnCount || t >= opts.arm.timeoutMs) {
							events.push(
								s.won ? "won" : s.respawnCount > start.respawnCount ? "respawned-while-armed" : "arm-timeout",
							);
							return { events, before, after: s, elapsedMs: 0, armedForMs: Math.round(t) };
						}
						floorPlatforms = Math.min(floorPlatforms, s.platformCount);
					}
				}
				if (opts.dir === "right") b.input.right = true;
				if (opts.dir === "left") b.input.left = true;
				const t0 = performance.now();
				let lastHop = -1_000;
				let jumped = false;
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
					before,
					after: s,
					elapsedMs: Math.round(performance.now() - t0),
					armedForMs,
				};
			},
			{ dir, hop, jumpAtX, untilX, budget, arm: armOpts },
		);
		const reply = {
			events: result.events,
			before: result.before,
			elapsedMs: result.elapsedMs,
			state: compact(result.after),
		};
		if (armOpts) reply.armedForMs = result.armedForMs;
		return reply;
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
		const video = page?.video() ?? null;
		await closeForVideo(page);
		const videoFile = await saveVideo(video, "laptop");
		await browser?.close().catch(() => {});
		setTimeout(() => process.exit(0), 250);
		return { ok: true, videoFile, note: "laptop driver exiting" };
	},
};

startServer("laptop-driver", PORT, routes);
