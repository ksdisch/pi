import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: this extension lives outside packages/, so no workspace vitest
// project picks it up. Run from the repo root with:
//   node node_modules/vitest/dist/cli.js --run --config .pi/extensions/intercom/vitest.config.ts
//
// No workspace aliases are needed: store.ts and format.ts have no pi imports, and
// index.ts's only pi-coding-agent import is type-only (erased at runtime); its runtime
// imports (pi-tui, typebox) resolve from the repo root without pulling pi's agent
// runtime into the test process.
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		reporters: ["dot"],
	},
});
