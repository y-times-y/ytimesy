/**
 * Signs in as the synthetic test account, for live verification
 * (docs/testing-live.md). Needs only YTIMESY_TEST_SESSION_TOKEN; no database.
 *
 *   node --import tsx scripts/test-session.ts mint
 *   node --import tsx scripts/test-session.ts shot --path / --out /tmp/a.png \
 *       [--step "fill:Message=hi"] [--step "click:Send"] [--step "wait:20000"]
 *   node --import tsx scripts/test-session.ts reset
 *
 * It takes no user id or email: the server fixes the target to the one
 * account flagged is_test_account, and refuses anything else.
 */
import { parseArgs } from "node:util";

export const DEFAULT_BASE = "https://ytimesy.com";

export type TestSessionResult = {
	cookie: { name: string; value: string };
	expiresAt: string;
	user: { id: string; email: string };
};

const COMMANDS = [
	"mint",
	"shot",
	"reset",
	"seed",
	"seed-usage",
	"y-counts",
] as const;

export function callerFromEnvironment(env: NodeJS.ProcessEnv) {
	return (
		env.YTIMESY_THREAD_ID ||
		env.YTIMESY_CHAT_ID ||
		env.YTIMESY_SESSION_ID ||
		"unknown-agent"
	);
}

/** Options are strict: `--user`, `--email` and anything unknown are errors. */
export function parseCli(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: {
			base: { type: "string", default: DEFAULT_BASE },
			caller: { type: "string" },
			path: { type: "string", default: "/" },
			out: { type: "string" },
			step: { type: "string", multiple: true },
			width: { type: "string", default: "1440" },
			height: { type: "string", default: "900" },
		},
	});
	const command = positionals[0];
	if (!COMMANDS.includes(command as (typeof COMMANDS)[number]))
		throw new Error(
			"Usage: test-session.ts <mint|shot|reset|seed|seed-usage|y-counts> [options]",
		);
	if (command === "shot" && !values.out)
		throw new Error("Pass --out <file.png>.");
	return { command: command as (typeof COMMANDS)[number], ...values };
}

export async function requestTestSession(input: {
	base: string;
	token: string | undefined;
	caller: string;
	action: "mint" | "reset" | "seed" | "seed-usage" | "y-counts";
	/** Only `seed`: the model key to connect, sealed server-side; never printed. */
	apiKey?: string;
	fetcher?: typeof fetch;
}) {
	if (!input.token) throw new Error("YTIMESY_TEST_SESSION_TOKEN is not set.");
	const response = await (input.fetcher ?? fetch)(
		new URL("/api/internal/test-session", input.base),
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${input.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				action: input.action,
				caller: input.caller,
				apiKey: input.apiKey,
			}),
		},
	);
	if (!response.ok)
		throw new Error(
			`Test session refused (${response.status}): ${await response.text()}`,
		);
	return (await response.json()) as TestSessionResult & {
		projectsRemoved?: number;
	};
}

async function shot(
	session: TestSessionResult,
	options: ReturnType<typeof parseCli>,
) {
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch({
		executablePath: process.env.CHROME_PATH || undefined,
		channel: process.env.CHROME_PATH ? undefined : "chrome",
		headless: true,
	});
	try {
		const base = new URL(options.base);
		const context = await browser.newContext({
			viewport: {
				width: Number(options.width),
				height: Number(options.height),
			},
		});
		await context.addCookies([
			{
				name: session.cookie.name,
				value: session.cookie.value,
				domain: base.hostname,
				path: "/",
				httpOnly: true,
				secure: base.protocol === "https:",
				sameSite: "Lax",
			},
		]);
		const page = await context.newPage();
		await page.goto(new URL(options.path ?? "/", base).toString());
		await page.waitForTimeout(2500);
		for (const step of options.step ?? []) {
			const [kind, rest = ""] = [
				step.slice(0, step.indexOf(":")),
				step.slice(step.indexOf(":") + 1),
			];
			if (kind === "click")
				await page.getByText(rest, { exact: false }).first().click();
			else if (kind === "fill") {
				const at = rest.indexOf("=");
				await page
					.getByLabel(rest.slice(0, at))
					.or(page.getByPlaceholder(rest.slice(0, at)))
					.first()
					.fill(rest.slice(at + 1));
			} else if (kind === "press") await page.keyboard.press(rest);
			else if (kind === "eval")
				console.error(JSON.stringify(await page.evaluate(rest)));
			else if (kind === "scroll") await page.mouse.wheel(0, Number(rest));
			else if (kind === "wait") await page.waitForTimeout(Number(rest));
			else throw new Error(`Unknown step ${kind}`);
		}
		await page.screenshot({ path: options.out as string, fullPage: false });
		console.log(
			JSON.stringify({
				screenshot: options.out,
				url: page.url(),
				title: await page.title(),
				text: (await page.locator("body").innerText()).slice(0, 4000),
			}),
		);
	} finally {
		await browser.close();
	}
}

if (process.argv[1]?.endsWith("test-session.ts")) {
	const options = parseCli(process.argv.slice(2));
	const result = await requestTestSession({
		base: options.base,
		token: process.env.YTIMESY_TEST_SESSION_TOKEN,
		caller: options.caller ?? callerFromEnvironment(process.env),
		action: options.command === "shot" ? "mint" : options.command,
		apiKey:
			options.command === "seed" ? process.env.ANTHROPIC_API_KEY : undefined,
	});
	if (options.command === "shot") await shot(result, options);
	else console.log(JSON.stringify(result));
}
