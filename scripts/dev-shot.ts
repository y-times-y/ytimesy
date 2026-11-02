/**
 * Screenshots any signed-in page of the development app, so UI behind sign-in
 * can be checked without a browser login. Development database only.
 *
 *   node --env-file=../cloud-launch/.env --import tsx scripts/dev-shot.ts \
 *     --path "/?settings=plugins" --out /tmp/plugins.png [--base http://127.0.0.1:8793] \
 *     [--click "Add token"] [--step "fill:Server URL=https://…"] [--width 1440] [--height 900]
 *
 * --click names a button, link or tab (or visible text); --step runs in order
 * after the clicks: "click:<name>", "fill:<label>=<value>", "wait:<ms>".
 *
 * Signs in as the dev subscription owner (or --user <id>) with a session that
 * lasts ten minutes and is deleted when the shot is taken.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { closeDatabase, database } from "../src/server/adapters/database";
import {
	assertDevelopmentDatabase,
	subscriptionOwner,
} from "./smoke/eval-user";

const { values } = parseArgs({
	options: {
		path: { type: "string", default: "/" },
		out: { type: "string" },
		base: { type: "string", default: "http://127.0.0.1:8793" },
		user: { type: "string" },
		click: { type: "string", multiple: true },
		step: { type: "string", multiple: true },
		width: { type: "string", default: "1440" },
		height: { type: "string", default: "900" },
		wait: { type: "string", default: "2500" },
	},
});
if (!values.out) throw new Error("Pass --out <file.png>.");

await assertDevelopmentDatabase();
const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) throw new Error("BETTER_AUTH_SECRET is not set.");
const userId = values.user ?? (await subscriptionOwner());
const sessionId = randomUUID();
const token = randomBytes(24).toString("base64url");
await database().query(
	`insert into auth_session(id,"expiresAt",token,"updatedAt","userId") values($1,now()+interval '10 minutes',$2,now(),$3)`,
	[sessionId, token, userId],
);
const signature = createHmac("sha256", secret).update(token).digest("base64");

const { chromium } = await import("playwright-core");
const browser = await chromium.launch({
	executablePath:
		process.env.CHROME_PATH ??
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	headless: true,
});
try {
	const base = new URL(values.base);
	const context = await browser.newContext({
		viewport: { width: Number(values.width), height: Number(values.height) },
		deviceScaleFactor: 2,
		colorScheme: "dark",
	});
	await context.addCookies([
		{
			name: "better-auth.session_token",
			value: encodeURIComponent(`${token}.${signature}`),
			domain: base.hostname,
			path: "/",
			httpOnly: true,
			sameSite: "Lax",
		},
	]);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));
	await page.goto(new URL(values.path, base).href, { waitUntil: "load" });
	await page.waitForTimeout(Number(values.wait));
	const steps = [
		...(values.click ?? []).map((text) => `click:${text}`),
		...(values.step ?? []),
	];
	for (const step of steps) {
		const [kind, ...restParts] = step.split(":");
		const rest = restParts.join(":");
		if (kind === "wait") {
			await page.waitForTimeout(Number(rest));
			continue;
		}
		if (kind === "fill") {
			const at = rest.indexOf("=");
			await page
				.getByLabel(rest.slice(0, at), { exact: true })
				.first()
				.fill(rest.slice(at + 1));
			continue;
		}
		const text = rest;
		// A button or link by its name first, then any visible text.
		const named = page
			.getByRole("button", { name: text, exact: true })
			.or(page.getByRole("link", { name: text, exact: true }))
			.or(page.getByRole("tab", { name: text, exact: true }));
		const target = (await named.count())
			? named.first()
			: page.getByText(text, { exact: true }).first();
		await target.click({ timeout: 10_000 });
		await page.waitForTimeout(800);
	}
	await page.screenshot({ path: values.out });
	console.log(
		`saved ${values.out}${errors.length ? `; page errors: ${errors.join(" | ")}` : ""}`,
	);
} finally {
	await browser.close();
	await database().query("delete from auth_session where id=$1", [sessionId]);
	await closeDatabase();
}
