import { mkdir, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Bundles the Claude runner box's tool server (src/server/claude-box-tools/
 * entry.ts) into one Node ES module, .ytimesy/claude-box-tools.mjs, which the
 * edge writes to each runner box once per version
 * (src/server/services/claude-box-tools-bundle.ts). It holds the same tool
 * code the edge runs and no secret: the identity token arrives per run.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CLAUDE_BOX_TOOLS_BUNDLE = resolve(
	root,
	".ytimesy/claude-box-tools.mjs",
);

let building: Promise<string> | undefined;

/** Builds the bundle (once per process) and returns its path. */
export function buildClaudeBoxTools(): Promise<string> {
	building ??= (async () => {
		const result = await build({
			entryPoints: [resolve(root, "src/server/claude-box-tools/entry.ts")],
			bundle: true,
			write: false,
			format: "esm",
			platform: "node",
			// The runner boxes' Node (infra/claude-runner-box/bootstrap.sh).
			target: "node22",
			minify: true,
			legalComments: "none",
			external: ["node:*", ...builtinModules],
			// Bundled CommonJS dependencies may require Node's own modules.
			banner: {
				js: 'import { createRequire as boxToolsCreateRequire } from "node:module"; const require = boxToolsCreateRequire(import.meta.url);',
			},
			logLevel: "warning",
		});
		const [output] = result.outputFiles;
		await mkdir(dirname(CLAUDE_BOX_TOOLS_BUNDLE), { recursive: true });
		await writeFile(CLAUDE_BOX_TOOLS_BUNDLE, output.text);
		return CLAUDE_BOX_TOOLS_BUNDLE;
	})();
	return building;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	console.log(await buildClaudeBoxTools());
