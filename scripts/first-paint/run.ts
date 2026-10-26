// First-paint guard: serves a production build of the web Worker locally
// (wrangler dev --local) against a throwaway Postgres with every migration
// and fixture chats, loads the main pages in Chrome under a 4x CPU throttle,
// and fails when layout shift (CLS) or hydration warnings regress past
// scripts/first-paint/budget.json.
//
//   YTIMESY_TARGET=cloudflare pnpm build
//   pnpm check:first-paint                 # compare with the budget
//   pnpm check:first-paint --update        # record the current numbers
//
// Needs Docker (the database: scripts/rehearsal/db.ts) and Google Chrome
// (CHROME_PATH, or the usual install path). No secrets, no hosted services:
// the remote bindings (edge executor, VPC egress, memory repos) are left out
// of the local Worker, and the pages measured do not use them.
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { freshDatabase } from "../rehearsal/db";
import { applyRehearsalEnvironment } from "../rehearsal/env";
import { FIRST_PAINT_CHATS } from "./fixtures";

const { values } = parseArgs({
	options: {
		dist: { type: "string", default: "dist" },
		port: { type: "string", default: "8798" },
		update: { type: "boolean", default: false },
		chrome: { type: "string" },
		/** Runs per scenario; the lowest CLS counts (a regression shifts every run). */
		runs: { type: "string", default: "2" },
		/** A directory for each scenario's final screenshot. */
		shots: { type: "string" },
	},
});
const root = resolve(import.meta.dirname, "../..");
const dist = resolve(values.dist);
const origin = `http://127.0.0.1:${values.port}`;
const budgetFile = join(import.meta.dirname, "budget.json");

type Measure = { cls: number; hydrationWarnings: number };
type Budget = {
	/** How much CLS may grow above a scenario's baseline. */
	clsMargin: number;
	baseline: Record<string, Measure>;
};

const HYDRATION =
	/hydrat|did not match|didn't match|#418|#419|#421|#422|#423|#425|server rendered|switched to client rendering/i;

function chromePath() {
	const candidates = [
		values.chrome,
		process.env.CHROME_PATH,
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
	];
	const found = candidates.find((path) => path && existsSync(path));
	if (!found) throw new Error("Google Chrome not found: set CHROME_PATH.");
	return found;
}

async function seed() {
	const { seedOwner, createRehearsalUser } = await import("../rehearsal/seed");
	const { harnessVariantFromFlags } = await import(
		"../../src/domain/harness-variant"
	);
	const { insertAgentSession } = await import(
		"../../src/server/adapters/agent-sessions"
	);
	const { database } = await import("../../src/server/adapters/database");
	const { recordLegalAcceptance } = await import(
		"../../src/server/adapters/legal-acceptance"
	);
	const owner = await seedOwner();
	const user = await createRehearsalUser(
		owner,
		"first paint",
		harnessVariantFromFlags(),
	);
	await recordLegalAcceptance(user.userId, "signup");
	const chats: Record<string, string> = {};
	for (const [index, chat] of FIRST_PAINT_CHATS.entries()) {
		const session = await insertAgentSession({
			userId: user.userId,
			projectId: user.projectId,
			workspaceId: user.workspaceId,
			harness: "api",
			title: chat.title,
			listedModelId: "gpt-6.1-sol",
		});
		await database().query(
			`update agent_session set status='ready', items=$2::jsonb,
				updated_at=now() - make_interval(hours => $3), created_at=now() - make_interval(hours => $3)
			 where id=$1`,
			[session.id, JSON.stringify(chat.items), index + 1],
		);
		chats[chat.key] = session.id;
	}
	const token = randomBytes(24).toString("base64url");
	await database().query(
		`insert into auth_session(id,"expiresAt",token,"updatedAt","userId") values($1,now()+interval '1 day',$2,now(),$3)`,
		[randomUUID(), token, user.userId],
	);
	const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET ?? "")
		.update(token)
		.digest("base64");
	return { chats, cookie: encodeURIComponent(`${token}.${signature}`) };
}

/** The built Worker's config without the bindings that only exist remotely. */
async function localWorkerConfig(work: string) {
	const built = JSON.parse(
		await readFile(join(dist, "server", "wrangler.json"), "utf8"),
	);
	for (const key of ["services", "vpc_networks", "artifacts", "send_email"])
		delete built[key];
	const config = join(dist, "server", "wrangler.first-paint.json");
	await writeFile(config, JSON.stringify(built));
	return { config, envFile: join(work, "worker.env") };
}

async function startWorker(
	config: string,
	envFile: string,
	databaseUrl: string,
) {
	const server = spawn(
		join(root, "node_modules/.bin/wrangler"),
		[
			"dev",
			"--local",
			"-c",
			config,
			"--env-file",
			envFile,
			"--port",
			values.port,
			"--ip",
			"127.0.0.1",
			"--inspector-port",
			"0",
			"--show-interactive-dev-session=false",
		],
		{
			cwd: root,
			env: {
				...process.env,
				CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl,
				WRANGLER_SEND_METRICS: "false",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let log = "";
	server.stdout?.on("data", (chunk) => {
		log += chunk;
	});
	server.stderr?.on("data", (chunk) => {
		log += chunk;
	});
	for (let attempt = 0; attempt < 90; attempt++) {
		if (server.exitCode !== null) break;
		const status = await fetch(`${origin}/privacy`)
			.then((response) => response.status)
			.catch(() => 0);
		if (status === 200) {
			// With --shots, the Worker's log is kept beside the screenshots.
			const shots = values.shots;
			if (shots)
				setInterval(
					() =>
						void writeFile(join(shots, "worker.log"), log).catch(
							() => undefined,
						),
					2000,
				).unref();
			return server;
		}
		await delay(1000);
	}
	server.kill();
	throw new Error(`The local Worker did not start.\n${log.slice(-3000)}`);
}

type Scenario = {
	name: string;
	path: string;
	signedIn: boolean;
	/** Text the page shows once rendered: proves it is the page meant. */
	expect: string;
	viewport: { width: number; height: number };
};

/** Layout shifts (without recent input) and React's hydration warnings. */
async function measure(
	scenario: Scenario,
	cookie: string,
	executablePath: string,
): Promise<
	Measure & { shifts: unknown[]; errors: string[]; rendered: boolean }
> {
	const browser = await chromium.launch({ executablePath, headless: true });
	try {
		const context = await browser.newContext({
			viewport: scenario.viewport,
			deviceScaleFactor: 1,
		});
		if (scenario.signedIn)
			await context.addCookies([
				{
					name: "better-auth.session_token",
					value: cookie,
					domain: "127.0.0.1",
					path: "/",
				},
			]);
		await context.addInitScript(() => {
			try {
				localStorage.setItem("ytimesy.replay-consent", "declined");
			} catch {}
			const shifts: unknown[] = [];
			Object.assign(window, { __shifts: shifts });
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries() as unknown as {
					value: number;
					hadRecentInput: boolean;
					startTime: number;
					sources: { node?: Node; currentRect: DOMRectReadOnly }[];
				}[])
					if (!entry.hadRecentInput)
						shifts.push({
							value: entry.value,
							at: Math.round(entry.startTime),
							nodes: entry.sources.map((source) =>
								source.node instanceof Element
									? `${source.node.tagName.toLowerCase()}.${source.node.className}`.slice(
											0,
											80,
										)
									: String(source.node?.nodeName),
							),
						});
			}).observe({ type: "layout-shift", buffered: true });
		});
		// One warm load first: the Worker's first request compiles its modules.
		const warm = await context.newPage();
		await warm.goto(origin + scenario.path, { waitUntil: "load" });
		await warm.close();
		const page = await context.newPage();
		const messages: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error" || message.type() === "warning")
				messages.push(message.text().slice(0, 400));
		});
		page.on("pageerror", (error) => messages.push(error.message.slice(0, 400)));
		const cdp = await context.newCDPSession(page);
		await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		await page.goto(origin + scenario.path, {
			waitUntil: "load",
			timeout: 120_000,
		});
		await page.waitForTimeout(3000);
		const shifts = (await page.evaluate(
			() => (window as unknown as { __shifts: { value: number }[] }).__shifts,
		)) as { value: number }[];
		const cls = shifts.reduce((sum, shift) => sum + shift.value, 0);
		const rendered =
			(await page
				.getByText(scenario.expect)
				.count()
				.catch(() => 0)) > 0;
		if (values.shots)
			await page.screenshot({
				path: join(values.shots, `${scenario.name}.png`),
			});
		return {
			rendered,
			cls: Math.round(cls * 10_000) / 10_000,
			hydrationWarnings: messages.filter((text) => HYDRATION.test(text)).length,
			shifts,
			errors: messages,
		};
	} finally {
		await browser.close();
	}
}

const work = await mkdtemp(join(tmpdir(), "ytimesy-first-paint-"));
if (values.shots) await mkdir(values.shots, { recursive: true });
const databaseName = "first_paint";
const databaseUrl = await freshDatabase(root, databaseName);
const before = { ...process.env };
applyRehearsalEnvironment(databaseUrl);
Object.assign(process.env, { APP_URL: origin, BETTER_AUTH_URL: origin });
const workerEnv = Object.entries(process.env).filter(
	([key, value]) =>
		before[key] !== value && value !== undefined && key !== "DATABASE_URL",
);
let server: ChildProcess | undefined;
let failed = false;
try {
	const { chats, cookie } = await seed();
	const { config, envFile } = await localWorkerConfig(work);
	await writeFile(
		envFile,
		// The Worker reaches the database through its Hyperdrive binding.
		[...workerEnv, ["DATABASE_URL", "hyperdrive"]]
			.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
			.join("\n"),
	);
	server = await startWorker(config, envFile, databaseUrl);
	const executablePath = chromePath();
	const viewports = {
		desktop: { width: 1440, height: 900 },
		phone: { width: 390, height: 844 },
	};
	const pages = [
		{ name: "landing", path: "/", signedIn: false, expect: "Free beta" },
		{ name: "home", path: "/", signedIn: true, expect: "Short chat" },
		{
			name: "chat-rich",
			path: `/?chat=${chats.rich}`,
			signedIn: true,
			expect: "Nothing else changes.",
		},
		{
			name: "chat-empty",
			path: `/?chat=${chats.empty}`,
			signedIn: true,
			expect: "New session",
		},
	];
	const scenarios: Scenario[] = pages.flatMap((page) =>
		Object.entries(viewports).map(([size, viewport]) => ({
			...page,
			name: `${page.name}-${size}`,
			viewport,
		})),
	);
	const budget = JSON.parse(await readFile(budgetFile, "utf8")) as Budget;
	const measured: Record<string, Measure> = {};
	for (const scenario of scenarios) {
		const runs = [];
		for (let run = 0; run < Number(values.runs); run++)
			runs.push(await measure(scenario, cookie, executablePath));
		const best = runs.reduce((a, b) => (b.cls < a.cls ? b : a));
		const hydrationWarnings = Math.max(
			...runs.map((run) => run.hydrationWarnings),
		);
		measured[scenario.name] = { cls: best.cls, hydrationWarnings };
		const base = budget.baseline[scenario.name];
		const rendered = runs.every((run) => run.rendered);
		const over =
			!rendered ||
			(!values.update &&
				(!base ||
					best.cls > base.cls + budget.clsMargin ||
					hydrationWarnings > base.hydrationWarnings));
		if (over) failed = true;
		if (!rendered)
			console.log(
				`FAIL ${scenario.name}: the page never showed "${scenario.expect}".`,
			);
		console.log(
			`${over ? "FAIL" : "ok  "} ${scenario.name.padEnd(18)} CLS ${best.cls.toFixed(4)} (baseline ${base?.cls.toFixed(4) ?? "none"}, +${budget.clsMargin} allowed)  hydration warnings ${hydrationWarnings} (baseline ${base?.hydrationWarnings ?? "none"})`,
		);
		if (over) {
			for (const shift of best.shifts.slice(0, 5))
				console.log("     shift", JSON.stringify(shift));
			for (const text of runs
				.flatMap((run) => run.errors)
				.filter((text) => HYDRATION.test(text))
				.slice(0, 3))
				console.log("     hydration", text);
		}
	}
	if (values.update) {
		await writeFile(
			budgetFile,
			`${JSON.stringify({ ...budget, baseline: measured }, null, "\t")}\n`,
		);
		console.log(`Recorded the baseline in ${budgetFile}.`);
	}
} finally {
	server?.kill();
	const { closeDatabase } = await import("../../src/server/adapters/database");
	await closeDatabase().catch(() => undefined);
	await rm(join(dist, "server", "wrangler.first-paint.json"), { force: true });
	await rm(work, { recursive: true, force: true });
}
if (failed) {
	console.error(
		"First paint regressed: layout shift or hydration warnings above scripts/first-paint/budget.json.",
	);
	process.exit(1);
}
process.exit(0);
