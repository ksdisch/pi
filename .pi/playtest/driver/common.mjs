import http from "node:http";

/**
 * Tiny JSON-over-HTTP command server. Commands are serialized through a single
 * promise chain: the drivers hold one live browser page, and two interleaved
 * maneuvers on it would corrupt both — a queued command waits its turn instead.
 */
export function startServer(name, port, routes) {
	let chain = Promise.resolve();
	const server = http.createServer(async (req, res) => {
		const send = (status, obj) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(`${JSON.stringify(obj)}\n`);
		};
		try {
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (path === "/health") return send(200, { ok: true, name });
			const handler = routes[path];
			if (!handler) return send(404, { error: `unknown command ${path}`, commands: Object.keys(routes) });
			let body = {};
			if (req.method === "POST") {
				const chunks = [];
				for await (const c of req) chunks.push(c);
				const raw = Buffer.concat(chunks).toString("utf8").trim();
				if (raw) body = JSON.parse(raw);
			}
			// /shutdown must not queue behind a wedged maneuver — the serial chain
			// is exactly what it may need to break.
			const result = path === "/shutdown" ? Promise.resolve().then(() => handler(body)) : chain.then(() => handler(body));
			if (path !== "/shutdown") chain = result.catch(() => {});
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
