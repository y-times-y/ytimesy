import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles the turn runner box's process (src/server/jobs/box-runner.ts) into
 * one Node ES module, .ytimesy/turn-box.mjs, which infra/turn-box/provision.py
 * puts on each box (docs/turn-runner-boxes.md). It holds code and no secret.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TURN_BOX_BUNDLE = resolve(root, ".ytimesy/turn-box.mjs");

/** run_code's QuickJS WebAssembly, carried inside the program (the box has no node_modules). */
function quickjsWasmBase64() {
	const entry = createRequire(resolve(root, "package.json")).resolve(
		"@jitl/quickjs-wasmfile-release-sync",
	);
	return readFileSync(
		resolve(dirname(entry), "emscripten-module.wasm"),
	).toString("base64");
}

export async function buildTurnBox(): Promise<string> {
	const result = await build({
		define: {
			__TURN_BOX_QUICKJS_WASM__: JSON.stringify(quickjsWasmBase64()),
		},
		entryPoints: [resolve(root, "src/server/jobs/box-runner.ts")],
		bundle: true,
		write: false,
		format: "esm",
		platform: "node",
		// The box's Node (infra/turn-box/bootstrap.sh).
		target: "node22",
		// Readable stack traces in the box log (the size does not matter here).
		minify: false,
		keepNames: true,
		legalComments: "none",
		external: ["node:*", ...builtinModules],
		banner: {
			js: 'import { createRequire as turnBoxCreateRequire } from "node:module"; const require = turnBoxCreateRequire(import.meta.url);',
		},
		logLevel: "warning",
	});
	const [output] = result.outputFiles;
	await mkdir(dirname(TURN_BOX_BUNDLE), { recursive: true });
	await writeFile(TURN_BOX_BUNDLE, output.text);
	return TURN_BOX_BUNDLE;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	console.log(await buildTurnBox());
