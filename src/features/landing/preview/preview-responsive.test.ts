import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPreviewCss } from "../../../../scripts/previews/build-css";
import { stylesheetsImportedBy } from "../../../../scripts/previews/css-imports";
import { PREVIEW } from "./preview.gen";

/**
 * The front page's preview at phone, tablet and desktop widths, in a real
 * browser with the real stylesheets. Skipped where no Chrome is installed
 * (set CHROME_PATH, or install Chrome, to run it).
 */
const CHROME = [
	process.env.CHROME_PATH,
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((path): path is string => Boolean(path) && existsSync(path as string));

const WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440];
const ROOT = resolve(import.meta.dirname, "../../../..");

describe.skipIf(!CHROME)("the front page preview is responsive", () => {
	let work = "";
	let page = "";
	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "ytimesy-responsive-"));
		const sheets = stylesheetsImportedBy(
			join(ROOT, "src/features/landing/preview/preview-demo.tsx"),
		);
		const css = buildPreviewCss(join(work, "css"), sheets, { landing: true });
		const html = PREVIEW["super-agent"];
		page = `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body style="margin:0;background:#000"><div class="landing"><section class="landing-hero"><div class="landing-shot-frame"><div class="landing-preview">${html}</div></div></section></div></body></html>`;
	}, 120_000);
	afterAll(() => rmSync(work, { recursive: true, force: true }));

	it.each(WIDTHS)(
		"at %ipx: fits, no sideways scroll, readable",
		async (width) => {
			const browser = await chromium.launch({
				executablePath: CHROME,
				args: ["--no-sandbox"],
			});
			try {
				const view = await browser.newPage({
					viewport: { width, height: 900 },
					deviceScaleFactor: 1,
				});
				await view.setContent(page);
				const result = await view.evaluate(() => {
					const preview = document.querySelector(".landing-preview");
					const box = preview?.getBoundingClientRect();
					const visible = (element: Element) => {
						const rect = element.getBoundingClientRect();
						const style = getComputedStyle(element);
						return (
							rect.width > 0 &&
							rect.height > 0 &&
							style.display !== "none" &&
							style.visibility !== "hidden"
						);
					};
					const scale = (() => {
						const shell = document.querySelector(
							".landing-preview .workspace-shell",
						);
						return shell
							? shell.getBoundingClientRect().width /
									(shell as HTMLElement).offsetWidth
							: 1;
					})();
					const overflowing: string[] = [];
					const small: string[] = [];
					for (const element of preview?.querySelectorAll("*") ?? []) {
						if (!visible(element)) continue;
						const rect = element.getBoundingClientRect();
						if (box && rect.right > box.right + 1)
							overflowing.push(
								element.className?.toString() || element.tagName,
							);
						const direct = [...element.childNodes].some(
							(node) => node.nodeType === 3 && node.textContent?.trim(),
						);
						if (direct) {
							const size =
								Number.parseFloat(getComputedStyle(element).fontSize) * scale;
							if (size < 11)
								small.push(`${element.className} ${size.toFixed(1)}px`);
						}
					}
					const rect = (selector: string) => {
						const element = document.querySelector(selector);
						if (!element || !visible(element)) return null;
						const r = element.getBoundingClientRect();
						return {
							top: r.top,
							bottom: r.bottom,
							left: r.left,
							right: r.right,
						};
					};
					return {
						scrollWidth: document.documentElement.scrollWidth,
						previewRight: box?.right ?? 0,
						overflowing: overflowing.slice(0, 5),
						small: small.slice(0, 5),
						scale,
						chat: rect(".welcome-panel"),
						overview: rect(".y-overview"),
						sidebar: rect(".project-sidebar"),
						chips: [
							...document.querySelectorAll(".landing-preview .reference-chip"),
						].filter(visible).length,
					};
				});
				expect(result.scrollWidth, "no sideways scroll").toBeLessThanOrEqual(
					width,
				);
				expect(result.previewRight).toBeLessThanOrEqual(width);
				expect(result.overflowing, "nothing sticks out of the preview").toEqual(
					[],
				);
				expect(result.chat, "the chat shows").not.toBeNull();
				expect(result.overview, "the Overview shows").not.toBeNull();
				// Under 1100px the picture is not scaled down: text stays its own size.
				if (width < 1100) {
					expect(result.scale).toBe(1);
					expect(result.small, "text under 11px").toEqual([]);
					expect(result.chips, "thread chips show").toBeGreaterThan(0);
				}
				// A phone shows the chat, then the Overview under it; a wider screen
				// shows them side by side.
				if (width < 560 && result.chat && result.overview) {
					expect(result.overview.top).toBeGreaterThanOrEqual(
						result.chat.bottom - 1,
					);
					expect(result.sidebar).toBeNull();
				}
				if (width >= 560 && result.chat && result.overview)
					expect(result.overview.left).toBeGreaterThanOrEqual(
						result.chat.right - 1,
					);
				if (width >= 900 && width < 1100) expect(result.sidebar).not.toBeNull();
				if (width >= 560 && width < 900) expect(result.sidebar).toBeNull();
			} finally {
				await browser.close();
			}
		},
		60_000,
	);
});
