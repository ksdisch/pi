import http from "node:http";
import path from "node:path";
import { HARNESS_DIR } from "./ports.mjs";

/**
 * Tiny JSON-over-HTTP command server. Commands are serialized through a single
 * promise chain: the drivers hold one live browser page, and two interleaved
 * maneuvers on it would corrupt both — a queued command waits its turn instead.
 *
 * `unqueued` lists routes that skip the chain. Only two kinds belong there:
 * /shutdown (always off-chain — the wedged chain is exactly what it may need to
 * break) and pure reads. A read is safe to run concurrently because what the
 * chain protects is interleaved *input*, not `getState()`; and it has to be,
 * because a read that queues behind a 90s armed hold answers long after the
 * thing it was asked about.
 */
export function startServer(name, port, routes, unqueued = []) {
	const offChain = new Set(["/shutdown", ...unqueued]);
	let chain = Promise.resolve();
	const server = http.createServer(async (req, res) => {
		const send = (status, obj) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(`${JSON.stringify(obj)}\n`);
		};
		try {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			// `harnessDir` is how a caller tells this driver apart from an identically
			// named one served by another checkout: the orchestrator refuses to shut
			// down a driver that answers with someone else's directory.
			if (path === "/health") return send(200, { ok: true, name, harnessDir: HARNESS_DIR });
			const handler = routes[path];
			if (!handler) return send(404, { error: `unknown command ${path}`, commands: Object.keys(routes) });
			let body = {};
			if (req.method === "POST") {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				if (raw) body = JSON.parse(raw);
			}
			const result = offChain.has(path) ? Promise.resolve().then(() => handler(body)) : chain.then(() => handler(body));
			if (!offChain.has(path)) chain = result.catch(() => {});
			send(200, (await result) ?? { ok: true });
		} catch (err) {
			send(500, { error: String(err instanceof Error ? err.message : err) });
		}
	});
	server.on("error", (err) => {
		const detail =
			err?.code === "EADDRINUSE" ? `port ${port} already in use — is a stale driver still running?` : String(err);
		console.error(`[${name}] server error: ${detail}`);
		process.exit(1);
	});
	server.listen(port, "127.0.0.1", () => {
		console.log(`[${name}] listening on http://127.0.0.1:${port}`);
	});
	return server;
}

/**
 * Spectator mode: `HEADED=1` opens real Chromium windows so Kyle can watch a run
 * happen. Headless stays the default — the players never see pixels either way
 * (DESIGN.md "Known limits"), so this changes nothing about what they perceive.
 */
export const launchOptions = () => ({ headless: process.env.HEADED !== "1" });

/**
 * `VIDEO_DIR` (set per run by run-pilot.sh) turns on Playwright's recorder, so a
 * finished run is watchable after the fact even when nobody was at the screen.
 */
export function contextOptions(viewport) {
	const dir = process.env.VIDEO_DIR;
	return dir ? { viewport, recordVideo: { dir, size: viewport } } : { viewport };
}

/**
 * Close the page's context so Playwright finalizes its video. Closing the whole
 * browser here instead would drop the connection `saveAs` still needs, leaving
 * the recording on disk under an unrecognizable `page@<hash>.webm` name.
 */
export async function closeForVideo(page) {
	await page?.context().close().catch(() => {});
}

/**
 * Flush a recorded video to a stable filename. Call after {@link closeForVideo}
 * and before closing the browser.
 */
export async function saveVideo(video, name) {
	const dir = process.env.VIDEO_DIR;
	if (!video || !dir) return null;
	const file = path.join(dir, `${name}.webm`);
	try {
		await video.saveAs(file);
		// saveAs copies, so drop the `page@<hash>.webm` original — two identical
		// recordings per run is just confusing.
		await video.delete().catch(() => {});
		return file;
	} catch {
		return null; // recorder never produced a file — not worth failing shutdown over
	}
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` every `stepMs` until it returns truthy or `timeoutMs` passes. */
export async function waitFor(fn, timeoutMs, stepMs = 150) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) return null;
		await sleep(stepMs);
	}
}
