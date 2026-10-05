import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

// Guest programs remain repository assets; Workers cannot read files from the developer's checkout.
await build({
	entryPoints: ["src/server/edge/executor.ts"],
	outfile: ".ytimesy/edge-executor.mjs",
	bundle: true,
	format: "esm",
	banner: {
		js: 'import { createRequire as workerCreateRequire } from "node:module"; const require = workerCreateRequire("/bundle/edge-executor.mjs");',
	},
	platform: "neutral",
	conditions: ["workerd", "worker", "browser"],
	mainFields: ["module", "main"],
	external: ["node:*", "cloudflare:*", ...builtinModules],
	plugins: [
		{
			name: "guest-program-assets",
			setup(builder) {
				builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
					if (!path.includes("/src/server/")) return;
					let contents = await readFile(path, "utf8");
					const pattern =
						/readFileSync\(\s*new URL\("([^"\n]+\.py)", import\.meta\.url\),\s*"utf8",?\s*\)/g;
					for (const match of [...contents.matchAll(pattern)]) {
						const asset = await readFile(
							resolve(dirname(path), match[1]),
							"utf8",
						);
						contents = contents.replace(match[0], JSON.stringify(asset));
					}
					return { contents, loader: "ts", resolveDir: dirname(path) };
				});
			},
		},
	],
});
