import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_CAPTURE_MJS } from "./pr-evidence-capture";
import { VISIBLE_APP_ERROR_SOURCE } from "./visible-app-error";

const browserPath =
	process.env.YTIMESY_TEST_BROWSER_PATH ??
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: chromium.executablePath());
const run = promisify(execFile);

const PAGES: Record<string, { status: number; html: string }> = {
	"/ok": { status: 200, html: "<h1>Settings</h1><p>Saved.</p>" },
	"/crash": {
		status: 200,
		html: '<h1>Something went wrong</h1><p>self-signed certificate in certificate chain</p><a href="/">Go home</a>',
	},
	"/mention": {
		status: 200,
		html: "<h1>Chat</h1><p>Something went wrong when I tried yesterday, can you look?</p>",
	},
	"/hidden": {
		status: 200,
		html: "<h1>Settings</h1><div hidden><h2>Something went wrong</h2></div>",
	},
	"/overlay": {
		status: 200,
		html: "<h1>Settings</h1><vite-error-overlay></vite-error-overlay>",
	},
	"/server-error": { status: 500, html: "<h1>Oops</h1>" },
};

describe.skipIf(!existsSync(browserPath))("visible app errors", () => {
	const http = createServer((request, response) => {
		const page = PAGES[request.url ?? ""] ?? { status: 404, html: "" };
		response.statusCode = page.status;
		response.setHeader("Content-Type", "text/html");
		response.end(`<title>Fixture</title>${page.html}`);
	});
	let base = "";
	beforeAll(async () => {
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const address = http.address();
		if (!address || typeof address === "string")
			throw new Error("Fixture did not bind");
		base = `http://127.0.0.1:${address.port}`;
	});
	afterAll(
		() =>
			new Promise<void>((resolve, reject) =>
				http.close((error) => (error ? reject(error) : resolve())),
			),
	);

	it("names a crash heading or overlay, and ignores mentions and hidden nodes", async () => {
		const visibleAppError = new Function(
			`${VISIBLE_APP_ERROR_SOURCE}\nreturn visibleAppError;`,
		)() as (page: Page) => Promise<string>;
		const browser = await chromium.launch({ executablePath: browserPath });
		try {
			const page = await browser.newPage();
			const shown: Record<string, string> = {};
			for (const path of ["/ok", "/crash", "/mention", "/hidden", "/overlay"]) {
				await page.goto(base + path);
				shown[path] = await visibleAppError(page);
			}
			expect(shown).toEqual({
				"/ok": "",
				"/crash": "Something went wrong",
				"/mention": "",
				"/hidden": "",
				"/overlay": "a dev-server error overlay",
			});
		} finally {
			await browser.close();
		}
	}, 30000);

	it("refuses capture media of a crashed page and keeps a healthy one", async () => {
		const capture = async (urls: string[]) => {
			const outDir = await mkdtemp(join(tmpdir(), "evidence-capture-"));
			try {
				const output = await run(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						EVIDENCE_CAPTURE_MJS,
						// The capture reads argv as when run from its file.
						"evidence-capture.mjs",
						process.cwd(),
						JSON.stringify({
							outDir,
							base,
							urls: urls.map((path) => base + path),
							flow: [],
							viewport: { width: 800, height: 600 },
							videoSize: { width: 400, height: 300 },
							videoSeconds: 20,
							stepTimeoutMs: 5000,
							maxScreenshots: 4,
							executablePath: browserPath,
							playwright: "test",
						}),
					],
					{ timeout: 60000 },
				);
				return {
					result: JSON.parse(output.stdout.trim().split("\n").at(-1) ?? ""),
					files: await readdir(outDir),
				};
			} finally {
				await rm(outDir, { recursive: true, force: true });
			}
		};
		const healthy = await capture(["/ok", "/mention"]);
		expect(healthy.result.appError).toBe("");
		expect(
			healthy.result.pages.map((page: { error: string }) => page.error),
		).toEqual(["", ""]);

		const crashed = await capture(["/ok", "/crash", "/server-error"]);
		expect(crashed.result.appError).toBe(`${base}/crash: Something went wrong`);
		expect(
			crashed.result.pages.map((page: { error: string }) => page.error),
		).toEqual(["", "Something went wrong", "answered HTTP 500"]);
	}, 90000);
});
