import { copyFile, readFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";
import { inlineGuestPrograms } from "./guest-program-assets";

// Guest programs remain repository assets; Workers cannot read files from the developer's checkout.
await build({
	entryPoints: [
		process.env.EDGE_RECOVERY_PROOF_BUILD === "1"
			? "tests/fixtures/edge-recovery-worker.ts"
			: "src/server/edge/executor.ts",
	],
	outfile: ".ytimesy/edge-executor.mjs",
	bundle: true,
	format: "esm",
	banner: {
		js: 'import { createRequire as workerCreateRequire } from "node:module"; const __filename = "/bundle/edge-executor.mjs"; const __dirname = "/bundle"; const require = workerCreateRequire(__filename);',
	},
	platform: "neutral",
	conditions: ["workerd", "worker", "browser"],
	mainFields: ["module", "main"],
	external: ["node:*", "cloudflare:*", ...builtinModules],
	plugins: [
		{
			// Wrangler bundles the module next to the output as precompiled WebAssembly.
			name: "code-mode-wasm",
			setup(builder) {
				builder.onResolve({ filter: /^\.\/quickjs\.wasm$/ }, () => ({
					path: "./quickjs.wasm",
					external: true,
				}));
			},
		},
		{
			name: "freestyle-worker-pty-transport",
			setup(builder) {
				builder.onResolve({ filter: /^ws$/ }, ({ importer }) => {
					if (!importer.includes("/freestyle/")) return;
					return { path: resolve("src/server/edge/freestyle-websocket.ts") };
				});
			},
		},
		{
			name: "guest-program-assets",
			setup(builder) {
				builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
					if (!path.includes("/src/server/")) return;
					const contents = await readFile(path, "utf8");
					return {
						contents: (await inlineGuestPrograms(path, contents)) ?? contents,
						loader: "ts",
						resolveDir: dirname(path),
					};
				});
			},
		},
	],
});
// Code mode's QuickJS module (code-mode-sandbox.ts), beside the bundle.
await copyFile(
	createRequire(import.meta.url).resolve(
		"@jitl/quickjs-wasmfile-release-sync/wasm",
	),
	".ytimesy/quickjs.wasm",
);
