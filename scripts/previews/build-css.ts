import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const slashes = (path: string) => path.split("\\").join("/");

/**
 * One stylesheet with the app's own CSS, the stylesheets the preview's
 * components import and, with `landing`, the front page's. Built with vite
 * into `outDir`; font and image urls point at the built files.
 */
export function buildPreviewCss(
	outDir: string,
	sheets: string[],
	options: { landing?: boolean } = {},
) {
	const entry = join(ROOT, "scripts/previews/entry.gen.ts");
	const files = [
		resolve(ROOT, "src/styles.css"),
		...(options.landing
			? [resolve(ROOT, "src/features/landing/landing-page.css")]
			: []),
		...sheets,
	];
	writeFileSync(
		entry,
		`${files
			.map(
				(sheet) =>
					`import "${slashes(relative(join(ROOT, "scripts/previews"), sheet))}";`,
			)
			.join("\n")}\n`,
	);
	try {
		const result = spawnSync(
			"pnpm",
			["exec", "vite", "build", "-c", "scripts/previews/vite.config.ts"],
			{
				cwd: ROOT,
				stdio: "inherit",
				env: { ...process.env, PREVIEW_CSS_DIR: outDir },
				shell: process.platform === "win32",
			},
		);
		if (result.status !== 0)
			throw new Error("The preview stylesheet build failed");
	} finally {
		rmSync(entry, { force: true });
	}
	const assets = join(outDir, "assets");
	const css = readdirSync(assets)
		.filter((file) => file.endsWith(".css"))
		.map((file) => readFileSync(join(assets, file), "utf8"))
		.join("\n");
	return css.replaceAll("url(./", `url(${pathToFileURL(assets).href}/`);
}
