import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import {
	BROWSER_INSPECTION_SOURCE,
	browserInspection,
} from "./browser-inspection";

const browserPath =
	process.env.YTIMESY_TEST_BROWSER_PATH ??
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: chromium.executablePath());
const run = promisify(execFile);

it.skipIf(!existsSync(browserPath))(
	"inspects a real browser, reports failed assertions, and does not expose input values",
	async () => {
		const http = createServer((request, response) => {
			if (request.url?.startsWith("/ping")) {
				response.end("ok");
				return;
			}
			response.setHeader("Content-Type", "text/html");
			response.end(
				'<title>Fixture</title><h1>Ready</h1><input value="private-input-value"><button>Save</button><script>setInterval(() => { console.log("fixture-observation"); fetch("/ping?token=private-query-value"); }, 100)</script>',
			);
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const address = http.address();
		if (!address || typeof address === "string")
			throw new Error("Fixture did not bind");
		const reserve = createNetServer();
		await new Promise<void>((resolve) =>
			reserve.listen(0, "127.0.0.1", resolve),
		);
		const debug = reserve.address();
		if (!debug || typeof debug === "string")
			throw new Error("Debug port did not bind");
		await new Promise<void>((resolve, reject) =>
			reserve.close((error) => (error ? reject(error) : resolve())),
		);
		const browser = await chromium.launch({
			executablePath: browserPath,
			args: [
				`--remote-debugging-port=${debug.port}`,
				"--remote-debugging-address=127.0.0.1",
			],
		});
		try {
			const page = await browser.newPage();
			const url = `http://127.0.0.1:${address.port}/`;
			await page.goto(url);
			const output = await run(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					BROWSER_INSPECTION_SOURCE.replace(
						"http://127.0.0.1:9222",
						`http://127.0.0.1:${debug.port}`,
					),
					process.cwd(),
					JSON.stringify({
						url,
						observeMilliseconds: 300,
						assertions: [
							{ selector: "h1", expectedText: "Ready", visible: true },
							{ selector: "button", expectedText: "Wrong", visible: true },
						],
					}),
				],
				{ timeout: 20000 },
			);
			const result = browserInspection.parse(JSON.parse(output.stdout));
			expect(result.assertions.map((assertion) => assertion.passed)).toEqual([
				true,
				false,
			]);
			expect(
				result.console.some((entry) => entry.text === "fixture-observation"),
			).toBe(true);
			expect(result.network.some((entry) => entry.url.endsWith("/ping"))).toBe(
				true,
			);
			expect(output.stdout).not.toContain("private-input-value");
			expect(output.stdout).not.toContain("private-query-value");
			expect(page.isClosed()).toBe(false);
		} finally {
			await browser.close();
			await new Promise<void>((resolve, reject) =>
				http.close((error) => (error ? reject(error) : resolve())),
			);
		}
	},
	30000,
);
