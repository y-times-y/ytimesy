/**
 * Makes public/thread-art/<palette>-<variant>.jpg (128px, for 2x screens).
 *
 *   cd scripts/thread-art
 *   npm install
 *   npx vite &            # serves the page on http://127.0.0.1:5301
 *   PLAYWRIGHT=/path/to/playwright-core/index.mjs \
 *   CHROME=/usr/bin/google-chrome node render.mjs
 *
 * The page needs WebGL. On a machine without a GPU the flags below make
 * Chrome use its software renderer.
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright-core");
const NAMES = [
	"dusk",
	"ember",
	"lagoon",
	"meadow",
	"orchid",
	"citrus",
	"glacier",
	"rosewood",
	"peach",
	"midnight",
	"sunrise",
];
const VARIANTS = 4;
const out = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../public/thread-art",
);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
	executablePath: process.env.CHROME,
	args: [
		"--no-sandbox",
		"--use-angle=swiftshader",
		"--use-gl=angle",
		"--enable-unsafe-swiftshader",
		"--ignore-gpu-blocklist",
	],
});
const page = await browser.newPage({
	viewport: { width: 80, height: 80 },
	deviceScaleFactor: 2,
});
for (const [palette, name] of NAMES.entries()) {
	for (let variant = 0; variant < VARIANTS; variant++) {
		await page.goto(
			`http://127.0.0.1:5301/?palette=${palette}&variant=${variant}`,
			{ waitUntil: "networkidle" },
		);
		await page.waitForTimeout(600);
		await (await page.$("#tile")).screenshot({
			path: join(out, `${name}-${variant}.jpg`),
			type: "jpeg",
			quality: 82,
		});
	}
}
await browser.close();
