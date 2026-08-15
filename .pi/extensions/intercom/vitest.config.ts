import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: this extension lives outside packages/, so no workspace vitest
// project picks it up. Run from the repo root with:
//   node node_modules/vitest/dist/cli.js --run --config .pi/extensions/intercom/vitest.config.ts
//
// One workspace alias is needed: index.ts's pi-coding-agent import is type-only (erased
// at runtime), but `Box`/`Text` from pi-tui is a runtime import, and that package's
// entry is `dist/index.js` — present locally after any build, absent in CI, where
// `npm ci --ignore-scripts` installs without building. Aliasing to the package's source
// mirrors how this extension's typecheck already resolves pi (the root tsconfig maps
// `@earendil-works/*` to `packages/*/src`), and keeps the CI job dist-free by design.
// typebox stays unaliased: it ships built files, so root resolution works everywhere.
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	resolve: {
		alias: {
			"@earendil-works/pi-tui": fileURLToPath(new URL("../../../packages/tui/src/index.ts", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		reporters: ["dot"],
	},
});
