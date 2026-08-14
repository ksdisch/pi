import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { closeForVideo, contextOptions, launchOptions, saveVideo, sleep, startServer, waitFor } from "./common.mjs";
import { DEFAULT_LAPTOP_PORT, HARNESS_DIR } from "./ports.mjs";

const GAME_URL = process.env.GAME_URL ?? "http://localhost:5180/?test=1";
// Default derived from this checkout's path (ports.mjs); the env override wins.
const PORT = Number(process.env.LAPTOP_DRIVER_PORT ?? DEFAULT_LAPTOP_PORT);
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
/**
 * How far the astronaut must rise after a jump press before the driver calls it
 * a real take-off, and how long it waits for that rise before calling the press
 * inert. A jump (v0 460px/s) lifts ~26px inside one 60ms poll, while a grounded
 * or falling astronaut rises 0 — so 8px is clear of both by a wide margin, and
 * 240ms is four polls. See the take-off notes on `/move`.
 */
const JUMP_RISE_PX = 8;
const JUMP_RESOLVE_MS = 240;

let browser = null;
let page = null;
/**
 * Where the astronaut last died, carried on the driver so a caller who did not
 * issue the move can still see it — the phone's world glance is exactly that
 * caller, and "what killed my partner" is the question the glance exists to
 * answer. `/move` sets it from the same capture that fills its own `diedAt`.
 */
let lastDeath = null;
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

	// `lastDeath` rides along so a glance from the phone can answer "what killed
	// them" — the live `x`/`y` in `state` is the RESPAWN point after a death, and
	// a seat reading that as a death site is the misattribution `diedAt` exists to
	// end. Null until the first death of the session.
	"/state": async () => ({ state: await snapshot(), lastDeath }),

	/**
	 * One maneuver as a single in-page loop — all timing runs in the browser, so
	 * one HTTP call buys a whole move no matter how slow the caller's turns are.
	 * `hop` bunny-hops on a fixed cadence; `jumpAtX` jumps exactly once when
	 * crossing that x (how a human takes a gap: jump at the lip, not on a timer).
	 * Stops on: won, a respawn (death), reaching untilX, or ms elapsed.
	 *
	 * `arm` pre-commits the whole maneuver on a partner's cast: the astronaut
	 * stands still until the trigger fires — "freeze" = enemyFrozen is on,
	 * "platform" = a platform exists — then waits one
	 * human reaction (ARM_REACTION_MS) and runs the move. The wait aborts without
	 * moving on death, win, or arm.timeoutMs; an armed player is still a
	 * stationary target, and that exposure is playtest data, not a bug.
	 *
	 * A death returns `diedAt` — where the astronaut was, not where the game put
	 * it back. The game respawns in the same frame it increments `respawnCount`,
	 * so a poll that sees the death already reads spawn coordinates; every pilot
	 * so far mistook those for death sites and blamed the wrong hazard. Both
	 * loops therefore keep the previous sample and return THAT: `diedAt` is the
	 * last position observed with the old respawn count, so it lags the true
	 * death by up to one 60ms poll (~14px at the 240px/s run speed). Its `y` is
	 * the part that ends the misattribution — standing-height y means something
	 * on the ground killed you, y far below means you fell.
	 *
	 * A death also returns `lastStoodAt` — the last spot the astronaut was
	 * RESTING on a surface before it died. `diedAt` says where the fall ended;
	 * this says what it fell off. Without it, "landed on the bridge and then ran
	 * off its far edge" and "never reached the bridge at all" are the same
	 * reply: both end `respawned` with a pit `diedAt` a few hundred px right of
	 * the hazard. Nineteen of the 68 aim-sweep trials were the first and read as
	 * the second. Resting is inferred from y alone — the game exposes no
	 * "on the ground" flag (`BridgeState` carries `astronautY` and nothing else
	 * about contact) — as two consecutive samples at the same height that were
	 * ARRIVED AT from above. That last clause is what keeps a jump's apex out:
	 * near the top the astronaut is barely moving, so two samples there can
	 * round to the same y, but the sample before them is always lower (larger y)
	 * because it was still climbing.
	 *
	 * `jumpAtX` returns a verdict, not a keypress. `jumped` used to be pushed
	 * the moment the driver set the jump input, which is a different claim from
	 * "the astronaut left the ground": the game only grants a jump from the
	 * ground, so a press issued while already airborne — past a pit's edge, say
	 * — does nothing, and every one of the eight aim-sweep trials that never
	 * left the ground still reported `jumped`. The driver now waits to see the
	 * astronaut rise JUMP_RISE_PX before pushing `jumped`, and pushes
	 * `jump-ignored` when the press was inert. The same verdict rides in a
	 * `jump: {tookOff, pressedAt, apexY}` field; `apexY` is the highest point
	 * reached after the press — which is also how a ceiling-clipped jump tells
	 * itself apart from a clean one. It covers the whole rest of the move, so
	 * with `hop` also on it can belong to a later bounce rather than to this
	 * jump; a lone `jumpAtX`, which is what a gap is taken with, has no later
	 * bounce to confuse it with.
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
				const at = (s) => ({ x: Math.round(s.astronautX), y: Math.round(s.astronautY) });
				const before = at(start);
				b.resetInput();
				const events = [];
				let armedForMs = null;
				// The last sample taken while the respawn count was still the old one —
				// the closest thing to "where it died" that a poll loop can see.
				let lastSeen = before;
				// The two previous samples' rounded y, for the rest test in the move loop:
				// a surface rest is a flat PAIR, and the sample before that pair is what
				// separates one from a jump's apex.
				let y1 = null;
				let y2 = null;
				// Last spot the astronaut was observed resting on a surface. Reported on a
				// death, where it names what was fallen off.
				let lastStood = null;
				if (opts.arm) {
					// Both triggers fire on the LEVEL, not on a rising edge: a human who
					// sees the enemy already frozen — or a bridge already standing over the
					// pit — just goes. For "platform" that is also the only workable rule
					// since the game made a summoned platform wait indefinitely until the
					// astronaut lands on it (constellation b7c308a, refined by d4f5a3c): a
					// re-cast onto an unarmed platform is banner-only, so a seat arming
					// after its partner banked the platform (the flow that game change was
					// built for) would wait out the whole 90s ceiling on an edge that can
					// never come, and then report `arm-timeout` — which the player prompt
					// defines as "no cast came". A driver that manufactures a coordination
					// failure is the exact defect class this harness is for.
					const ta = performance.now();
					for (;;) {
						await pause(60);
						const s = b.getState();
						const t = performance.now() - ta;
						const fired = opts.arm.on === "freeze" ? s.enemyFrozen : s.platformCount > 0;
						if (fired) {
							events.push("arm-fired");
							armedForMs = Math.round(t);
							await pause(opts.arm.reactionMs);
							// Re-baseline so the move loop's respawn check measures the
							// move, not deaths that already aborted the wait.
							start = b.getState();
							lastSeen = at(start);
							break;
						}
						if (s.won || s.respawnCount > start.respawnCount || t >= opts.arm.timeoutMs) {
							const died = s.respawnCount > start.respawnCount;
							events.push(s.won ? "won" : died ? "respawned-while-armed" : "arm-timeout");
							return {
								events,
								before,
								after: s,
								elapsedMs: 0,
								armedForMs: Math.round(t),
								// Where it stood when something reached it, not where the game
								// put it back. An armed astronaut is stationary, so this is the
								// arming spot — which is the point: it names the place that was
								// not as safe as the seat thought.
								diedAt: died ? lastSeen : null,
							};
						}
						lastSeen = at(s);
					}
				}
				if (opts.dir === "right") b.input.right = true;
				if (opts.dir === "left") b.input.left = true;
				// Seed the y history with the sample the move starts from — a real
				// reading one poll old, and after an armed wait the re-baselined one. It
				// matters most for a move that begins mid-air: without it the first
				// sample has no predecessor, and a jump requested on it would be judged
				// with no way to notice the astronaut was already climbing.
				y1 = lastSeen.y;
				const t0 = performance.now();
				let lastHop = -1_000;
				// The one-shot jump: where and when the driver pressed it, whether the
				// astronaut was already climbing at that moment (it can only have been
				// airborne, and the game grants no jump in the air), the highest point
				// reached since, and the verdict — null until the rise decides it.
				let jumpPress = null;
				let jumpApexY = null;
				let tookOff = null;
				let s = start;
				let diedAt = null;
				for (;;) {
					await pause(60);
					s = b.getState();
					const here = at(s);
					const t = performance.now() - t0;
					if (opts.hop && t - lastHop > 420) {
						b.input.jump = true;
						setTimeout(() => {
							b.input.jump = false;
						}, 120);
						lastHop = t;
					}
					// Nothing about the jump means anything once the astronaut is a
					// different life: the game respawns in the same frame it bumps the
					// count, and the spawn point is 36px ABOVE standing height — read as a
					// height sample it looks exactly like a rise, and would report a jump
					// that never happened as a take-off. The post-loop resolver picks up a
					// press left unjudged here.
					const alive = s.respawnCount === start.respawnCount;
					if (
						alive &&
						opts.jumpAtX != null &&
						jumpPress == null &&
						((opts.dir === "right" && s.astronautX >= opts.jumpAtX) ||
							(opts.dir === "left" && s.astronautX <= opts.jumpAtX))
					) {
						b.input.jump = true;
						setTimeout(() => {
							b.input.jump = false;
						}, 120);
						jumpPress = { at: here, t, climbing: y1 - here.y > 1 };
						jumpApexY = here.y;
					}
					// The apex keeps updating for the rest of the move, not just until the
					// verdict lands — a jump is only ~22px up at the first sample after the
					// press and tops out around 110px, so freezing it at the moment
					// `tookOff` resolves would report the take-off, not the peak.
					if (alive && jumpPress != null && here.y < jumpApexY) jumpApexY = here.y;
					// Resolve that press into a take-off or an inert keypress. `jumped` is
					// only pushed once the astronaut is seen to actually rise; a press made
					// while already climbing needs no wait at all, since being airborne is
					// the whole reason the game ignores it.
					if (alive && jumpPress != null && tookOff == null) {
						if (jumpPress.climbing) tookOff = false;
						else if (jumpPress.at.y - jumpApexY >= opts.jumpRisePx) tookOff = true;
						else if (t - jumpPress.t >= opts.jumpResolveMs) tookOff = false;
						if (tookOff != null) events.push(tookOff ? "jumped" : "jump-ignored");
					}
					if (s.won) {
						events.push("won");
						break;
					}
					if (s.respawnCount > start.respawnCount) {
						events.push("respawned");
						diedAt = lastSeen;
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
					// Everything below runs only on samples the astronaut survived, which
					// is why it sits under the break checks: on the death sample `s` is
					// already the respawned astronaut standing at spawn, and letting that
					// in would record spawn as the last surface it stood on.
					lastSeen = here;
					// A flat pair means resting. `y2 <= here.y` is the arrived-from-above
					// test that keeps a jump's apex out — see the docblock. (`y1` is
					// always a real reading by here; only `y2` can still be unset, on the
					// first sample of the move.)
					if (Math.abs(here.y - y1) <= 1 && (y2 == null || y2 <= here.y)) lastStood = here;
					y2 = y1;
					y1 = here.y;
				}
				b.resetInput();
				const elapsedMs = Math.round(performance.now() - t0);
				// A move that ended in the same breath as the jump press never saw the
				// astronaut rise. Input is off now, so spending a few polls watching costs
				// the maneuver nothing and beats guessing — except after a death or a win,
				// where the scene has moved on and the answer is already settled: a
				// respawn one poll after the press means it was falling, not climbing.
				if (jumpPress != null && tookOff == null) {
					if (!events.includes("respawned") && !events.includes("won")) {
						const tw = performance.now();
						while (performance.now() - tw < opts.jumpResolveMs) {
							await pause(60);
							const w = b.getState();
							// A death mid-wait ends the wait rather than feeding it: the same
							// spawn-is-higher-than-standing trap as in the loop.
							if (w.respawnCount > start.respawnCount) break;
							const y = Math.round(w.astronautY);
							if (y < jumpApexY) jumpApexY = y;
							if (jumpPress.at.y - jumpApexY >= opts.jumpRisePx) break;
						}
					}
					tookOff = !jumpPress.climbing && jumpPress.at.y - jumpApexY >= opts.jumpRisePx;
					events.push(tookOff ? "jumped" : "jump-ignored");
				}
				return {
					events,
					before,
					after: s,
					elapsedMs,
					armedForMs,
					diedAt,
					lastStood,
					jump: jumpPress == null ? null : { tookOff, pressedAt: jumpPress.at, apexY: jumpApexY },
				};
			},
			{ dir, hop, jumpAtX, untilX, budget, arm: armOpts, jumpRisePx: JUMP_RISE_PX, jumpResolveMs: JUMP_RESOLVE_MS },
		);
		const reply = {
			events: result.events,
			before: result.before,
			elapsedMs: result.elapsedMs,
			state: compact(result.after),
		};
		// Same omit-when-absent rule as `diedAt`: a `jump` field means the driver
		// reached the requested x and pressed there. A `jumpAtX` that never came up
		// — the astronaut died first, or the move ended before reaching it — leaves
		// the field off rather than reporting on a jump that was never attempted.
		if (result.jump) reply.jump = result.jump;
		// Only on a death: `state` is post-respawn truth, `diedAt` is where the
		// astronaut actually was. Omitted entirely when nothing died, so its
		// presence is the signal and no stale field can be misread as one.
		if (result.diedAt) {
			reply.diedAt = result.diedAt;
			// What it fell OFF, when the driver caught it standing on anything during
			// this move. Absent on a `respawned-while-armed` death — an armed astronaut
			// stands still, so `diedAt` is already the spot it was standing in — and on
			// a move that never once observed it at rest.
			if (result.lastStood) reply.lastStoodAt = result.lastStood;
			// Kept for /state, where the age matters: a glance arriving much later
			// must be able to tell "just now" from "ten deaths ago", so the death's
			// own respawn count and wall-clock time travel with the position.
			lastDeath = {
				...result.diedAt,
				...(result.lastStood ? { lastStoodAt: result.lastStood } : {}),
				respawnCount: result.after.respawnCount,
				atIso: new Date().toISOString(),
			};
		}
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

// /state runs off the serial command chain: it only reads, and the phone
// driver's world glance (phone.mjs `/read`) asks for it while this seat may be
// holding a 90s armed move.
startServer("laptop-driver", PORT, routes, ["/state"]);
