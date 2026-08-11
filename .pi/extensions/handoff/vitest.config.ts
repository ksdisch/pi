import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: this extension lives outside packages/, so no workspace vitest
// project picks it up. Run from the repo root with:
//   node node_modules/vitest/dist/cli.js --run --config .pi/extensions/handoff/vitest.config.ts
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		reporters: ["dot"],
	},
});
