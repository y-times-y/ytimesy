/**
 * Measures Main's composer and the side chat's composer, rendered from the
 * real components with the app's compiled CSS, and asserts they share a bottom
 * baseline (within 1 px) and the side chat's gutters, at 1440, 1024 and 390 px.
 *
 *   node --import tsx scripts/measure-composers.ts <label> [--base https://...]
 *
 * Without --base it uses the checkout's compiled CSS. With --base it signs in
 * as the synthetic test account (scripts/test-session.ts mint) and measures
 * that deployment's own stylesheets on the same real components' markup. Screenshots (with guide lines) go to
 * ~/.ytimesy/captures/composers-<label>-<width>.png.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { buildPreviewCss } from "./previews/build-css.ts";
import { stylesheetsImportedBy } from "./previews/css-imports.ts";

const ROOT = resolve(import.meta.dirname, "..");
const label = process.argv[2] ?? "run";
const work = mkdtempSync(join(tmpdir(), "composers-"));
const out = join(homedir(), ".ytimesy/captures");
mkdirSync(out, { recursive: true });

const render = spawnSync(
	"pnpm",
	[
		"exec",
		"vitest",
		"run",
		"src/features/landing/preview/split-chat.render.test.tsx",
	],
	{
		cwd: ROOT,
		stdio: ["ignore", "ignore", "inherit"],
		env: { ...process.env, SPLIT_CHAT_OUT: join(work, "split") },
	},
);
if (render.status !== 0) throw new Error("render failed");
const sheets = stylesheetsImportedBy(
	join(ROOT, "src/features/landing/preview/preview-demo.tsx"),
);
const base = process.argv.includes("--base")
	? (process.argv[process.argv.indexOf("--base") + 1] ?? "https://ytimesy.com")
	: null;

/** The deployed build's own stylesheets, fetched as the synthetic test account. */
async function liveCss(origin: string) {
	const mint = spawnSync(
		"node",
		["--import", "tsx", "scripts/test-session.ts", "mint"],
		{
			cwd: ROOT,
			encoding: "utf8",
		},
	);
	const { cookie } = JSON.parse(mint.stdout.trim().split("\n").pop() ?? "{}");
	const html = await (
		await fetch(`${origin}/projects`, {
			headers: { cookie: `${cookie.name}=${cookie.value}` },
		})
	).text();
	const hrefs = [...html.matchAll(/href="([^"]+\.css)"/g)].map(
		(m) => m[1] as string,
	);
	const sheets = await Promise.all(
		hrefs.map(async (href) => (await fetch(new URL(href, origin))).text()),
	);
	return sheets.join("\n");
}
const css = base
	? await liveCss(base)
	: buildPreviewCss(join(work, "css"), sheets);

const page = (body: string) =>
	`<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0;background:#0a0a0a">${body}</body></html>`;
const sizes = [
	{ width: 1440, height: 900, stacked: false },
	{ width: 1024, height: 768, stacked: false },
	{ width: 390, height: 844, stacked: true },
] as const;

const browser = await chromium.launch({
	executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
	headless: !process.env.HEADED,
	args: ["--no-sandbox"],
});
const failures: string[] = [];
const rows: unknown[] = [];
for (const size of sizes) {
	const html = readFileSync(
		join(work, `split.${size.stacked ? "stacked" : "row"}.html`),
		"utf8",
	);
	const file = join(work, `p-${size.width}.html`);
	writeFileSync(file, page(html));
	const tab = await browser.newPage({
		viewport: { width: size.width, height: size.height },
	});
	await tab.addInitScript("window.__name = (fn) => fn");
	await tab.goto(pathToFileURL(file).href);
	const m = await tab.evaluate(() => {
		const read = (name: string) => {
			const panel = document.querySelector(
				`[data-measure="${name}"]`,
			) as HTMLElement;
			const composer = panel.querySelector(".session-composer") as HTMLElement;
			const p = panel.getBoundingClientRect();
			const c = composer.getBoundingClientRect();
			return {
				panelBottom: p.bottom,
				bottom: c.bottom,
				top: c.top,
				height: c.height,
				offset: p.bottom - c.bottom,
				left: c.left - p.left,
				right: p.right - c.right,
				width: c.width,
				panelWidth: p.width,
				radius: getComputedStyle(composer).borderTopLeftRadius,
			};
		};
		const main = read("main"),
			side = read("side");
		for (const r of [main, side]) {
			const line = document.createElement("div");
			line.style.cssText = `position:fixed;left:0;right:0;top:${r.bottom}px;height:1px;background:#f0f;z-index:99`;
			document.body.append(line);
		}
		return { main, side };
	});
	await tab.screenshot({
		path: join(out, `composers-${label}-${size.width}.png`),
	});
	await tab.close();
	rows.push({ width: size.width, ...m });
	const tag = `${size.width}px`;
	if (Math.abs(m.main.offset - m.side.offset) > 1)
		failures.push(
			`${tag}: bottom offset main ${m.main.offset.toFixed(1)} vs side ${m.side.offset.toFixed(1)}`,
		);
	if (!size.stacked && Math.abs(m.main.bottom - m.side.bottom) > 1)
		failures.push(
			`${tag}: composer bottom edges differ by ${(m.main.bottom - m.side.bottom).toFixed(1)}`,
		);
	if (Math.abs(m.side.left - 12) > 1 || Math.abs(m.side.right - 12) > 1)
		failures.push(
			`${tag}: side gutters ${m.side.left.toFixed(1)}/${m.side.right.toFixed(1)} (want 12)`,
		);
}
await browser.close();
console.log(JSON.stringify(rows, null, 1));
if (failures.length) {
	console.log(`FAIL\n${failures.join("\n")}`);
	process.exit(1);
}
console.log("PASS: composers aligned within 1 px at 1440, 1024 and 390");
