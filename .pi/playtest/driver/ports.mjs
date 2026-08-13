import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Identity of this checkout of the harness, and the driver ports derived from
 * it. Both drivers, `run-pilot.sh` and `verify-rails.sh` read their defaults
 * from here, so every side of one checkout agrees and no two checkouts collide.
 *
 * Why this file exists: pilot 3's second run was silently corrupted because
 * `~/Projects/party-line` holds a copy of this harness and both copies defaulted
 * to the fixed ports 4801/4802. `run-pilot.sh` shuts down whatever answers those
 * ports before starting its own drivers, so each run killed the other's drivers
 * and then drove the survivor's game — producing a plausible-looking clear that
 * belonged to neither pair. Two checkouts must not be able to reach each other
 * by accident.
 *
 * `realpathSync` matters: a checkout reached through a symlink would otherwise
 * hash to a different slot than the same checkout reached directly, and the two
 * would then fight over each other's ports exactly as the copies did.
 */
export const HARNESS_DIR = realpathSync(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/**
 * Ports live in 41000-44999: above the registered range dev servers cluster in,
 * below macOS's ephemeral range (49152+), so a derived port can't collide with
 * a kernel-assigned client port. Pairs are allocated on a stride of 2 so one
 * checkout's laptop port can never be another's phone port — collisions stay
 * whole-pair (p ≈ 1/2000 between any two checkouts) and are then caught by the
 * HARNESS_DIR check rather than corrupting a run.
 */
const PORT_BASE = 41_000;
const PORT_PAIRS = 2_000;
const slot = createHash("sha256").update(HARNESS_DIR).digest().readUInt32BE(0) % PORT_PAIRS;

export const DEFAULT_LAPTOP_PORT = PORT_BASE + slot * 2;
export const DEFAULT_PHONE_PORT = DEFAULT_LAPTOP_PORT + 1;

// `node driver/ports.mjs --env` prints shell assignments for the two scripts to
// eval, so bash never recomputes the hash (or the realpath) for itself.
const invokedDirectly = process.argv[1] ? realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly && process.argv[2] === "--env") {
	const shellQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
	console.log(`PI_PLAYTEST_HARNESS_DIR=${shellQuote(HARNESS_DIR)}`);
	console.log(`PI_PLAYTEST_LAPTOP_PORT=${DEFAULT_LAPTOP_PORT}`);
	console.log(`PI_PLAYTEST_PHONE_PORT=${DEFAULT_PHONE_PORT}`);
}
