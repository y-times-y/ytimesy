import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { expect, it } from "vitest";
import { posixShellQuoted } from "#/domain/posix-command";
import {
	browserUseCommand,
	PINNED_BROWSER_USE_VERSION,
} from "./browser-use-cli";

it("pins the maintained CLI and scopes it to local guest Chrome without telemetry or cloud billing", () => {
	const command = browserUseCommand("session", "print('literal $(not-shell)')");
	expect(command).toContain(`browser-use==${PINNED_BROWSER_USE_VERSION}`);
	expect(command).toContain("importlib.metadata.version");
	expect(command).toContain("BU_CDP_URL=http://127.0.0.1:9222");
	expect(command).toContain("BH_TELEMETRY=0");
	expect(command).toContain("BH_RECORD=0");
	expect(command).toContain("flock -w 180");
	expect(command).not.toContain("BROWSER_USE_API_KEY");
	expect(browserUseCommand("sibling", "print(1)")).not.toContain(
		command.match(/BH_HOME=(.*)/)?.[1],
	);
});

const cli = process.env.YTIMESY_TEST_BROWSER_USE_CLI;
const browserPath =
	process.env.YTIMESY_TEST_BROWSER_PATH ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const run = promisify(execFile);

it.skipIf(!cli || !existsSync(browserPath))(
	"controls a disposable real browser across CLI invocations and verifies a click",
	async () => {
		if (!cli) throw new Error("CLI path required");
		const root = await mkdtemp(join("/tmp", "yb-proof-"));
		const http = createServer((_request, response) => {
			response.setHeader("Content-Type", "text/html");
			response.end(
				"<title>Isolated fixture</title><button id=\"save\" onclick=\"document.querySelector('h1').textContent='Saved'\">Save</button><h1>Ready</h1>",
			);
		});
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const reserve = createNetServer();
		await new Promise<void>((resolve) =>
			reserve.listen(0, "127.0.0.1", resolve),
		);
		const debug = reserve.address();
		const address = http.address();
		if (
			!debug ||
			typeof debug === "string" ||
			!address ||
			typeof address === "string"
		)
			throw new Error("Fixture ports unavailable");
		await new Promise<void>((resolve) => reserve.close(() => resolve()));
		const browser = await chromium.launch({
			executablePath: browserPath,
			args: [
				`--remote-debugging-port=${debug.port}`,
				"--remote-debugging-address=127.0.0.1",
			],
		});
		const env = {
			...process.env,
			BH_HOME: root,
			BU_CDP_URL: `http://127.0.0.1:${debug.port}`,
			BH_TELEMETRY: "0",
			ANONYMIZED_TELEMETRY: "false",
			BH_RECORD: "0",
			BH_TAB_MARKER: "0",
			BU_AUTOSPAWN: "0",
		};
		const invoke = (code: string) =>
			run(
				"/bin/sh",
				[
					"-c",
					`printf '%s' ${posixShellQuoted(code)} | ${posixShellQuoted(cli)}`,
				],
				{ env, timeout: 30000 },
			);
		try {
			const first = await invoke(
				`new_tab("http://127.0.0.1:${address.port}/")\nwait_for_load()\nprint(js("document.querySelector('h1').textContent"))`,
			);
			expect(first.stdout).toContain("Ready");
			const second = await invoke(
				`r=js("JSON.stringify(document.querySelector('#save').getBoundingClientRect().toJSON())")\nimport json\nr=json.loads(r)\nclick_at_xy(r['x']+r['width']/2,r['y']+r['height']/2)\nprint(js("document.querySelector('h1').textContent"))\nprint(capture_screenshot())`,
			);
			expect(second.stdout).toContain("Saved");
			expect(second.stdout).toContain("shot.png");
			expect(
				(await readFile(join(root, "tmp", "shot.png")))
					.subarray(0, 8)
					.toString("hex"),
			).toBe("89504e470d0a1a0a");
		} finally {
			await run(cli, ["--reload"], { env, timeout: 10000 }).catch(() => {});
			await browser.close();
			await new Promise<void>((resolve) => http.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	},
	60000,
);
