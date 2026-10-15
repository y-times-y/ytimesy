// Development-only per-model smoke suite for the builder harness. Each run gets
// a disposable VM with a tiny fixture repository, one ROOT builder session and
// one turn; a deterministic verifier then runs on the VM. See
// docs/model-smoke-suite.md.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { WorkspaceId } from "../src/domain/ids";
import { modelRouteId } from "../src/domain/model-connection";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "../src/domain/session-item";
import { publicToolDetail } from "../src/domain/tool-detail";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../src/server/adapters/database";
import { CHEAP_BASE_SNAPSHOT } from "../src/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import {
	dispatchModelWorkflow,
	modelWorkflowSigningSecret,
} from "../src/server/adapters/model-workflow-dispatch";
import {
	apiModelCatalog,
	sendApiWorkspaceTask,
} from "../src/server/services/api-workspace-session";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";

const DEV_REF = "exampledevprojectref";
const ORIGIN =
	"https://ytimesy-edge-executor-development.example-account.workers.dev";
const DEFAULT_MODELS = [
	"codex:gpt-6.1-sol",
	"anthropic/claude-sonnet-5.5",
	"google/gemini-3.8-flash",
	"deepseek/deepseek-v4.1-flash",
];
// Conservative USD per million tokens (input, output); cached input is billed
// at the full input rate so the cap errs high. Override with --price.
const DEFAULT_PRICES: Record<string, [number, number]> = {
	"codex:gpt-6.1-sol": [0, 0],
	"anthropic/claude-sonnet-5.5": [3, 15],
	"google/gemini-3.8-flash": [0.6, 3.5],
	"deepseek/deepseek-v4.1-flash": [0.4, 1.6],
};
const UNKNOWN_PRICE: [number, number] = [5, 25];
// Each run reserves this much worst-case spend before it starts and is
// cancelled if its recorded usage exceeds the reservation.
const RESERVED_TOKENS = { input: 250_000, output: 15_000 };

type Task = {
	id: string;
	prompt: string;
	files: Record<string, string>;
	verify: string;
};

const HEADER_RULE = "# owner: smoke-team";
const TASKS: Task[] = [
	{
		id: "count-script",
		prompt:
			"Create count.py: `python3 count.py <file>` prints only the number of whitespace-separated words in that file. Test it on a.txt and on b.txt.",
		files: {
			"README.md": "Word counting fixture.\n",
			"a.txt": "one two three\n",
			"b.txt": "alpha beta\ngamma  delta\n\nepsilon zeta eta\n",
		},
		verify: [
			"set -e",
			'[ "$(python3 count.py a.txt | tr -d "[:space:]")" = 3 ]',
			'[ "$(python3 count.py b.txt | tr -d "[:space:]")" = 7 ]',
			"printf 'x y\\nz w v\\n' > /tmp/smoke-extra.txt",
			'[ "$(python3 count.py /tmp/smoke-extra.txt | tr -d "[:space:]")" = 5 ]',
		].join("\n"),
	},
	{
		id: "edit-function",
		prompt:
			"Update slugify in the textkit package so `python3 -m unittest discover -s tests -t .` passes. Do not modify tests.",
		files: {
			"textkit/__init__.py": "from .core import slugify\n",
			"textkit/core.py":
				'def slugify(text):\n    """Return a URL slug for text."""\n    return text.lower()\n',
			"tests/__init__.py": "",
			"tests/test_slugify.py":
				"import unittest\n\nfrom textkit import slugify\n\n\nclass SlugifyTest(unittest.TestCase):\n    def test_spaces_and_punctuation(self):\n        self.assertEqual(slugify('Hello, World!'), 'hello-world')\n\n    def test_collapses_separators(self):\n        self.assertEqual(slugify('  Many   spaces -- here '), 'many-spaces-here')\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
		},
		verify:
			"set -e\ngit diff --quiet HEAD -- tests\npython3 -m unittest discover -s tests -t . 2>&1 | tail -3",
	},
	{
		id: "fix-failing-test",
		prompt:
			"The tests in tests/test_stats.py fail. Fix the bug in the source code (not the tests) and confirm the tests pass.",
		files: {
			"stats.py":
				"def mean(values):\n    return sum(values) / (len(values) - 1)\n\n\ndef spread(values):\n    return max(values) - min(values)\n",
			"tests/__init__.py": "",
			"tests/test_stats.py":
				"import unittest\n\nfrom stats import mean, spread\n\n\nclass StatsTest(unittest.TestCase):\n    def test_mean(self):\n        self.assertEqual(mean([2, 4, 6]), 4)\n\n    def test_spread(self):\n        self.assertEqual(spread([3, 9, 1]), 8)\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
		},
		verify:
			"set -e\ngit diff --quiet HEAD -- tests\npython3 -m unittest discover -s tests -t . 2>&1 | tail -3",
	},
	{
		id: "rename-function",
		prompt:
			"Rename the function compute_total to calculate_total everywhere it is defined or used, and keep `python3 -m unittest discover -s tests -t .` passing.",
		files: {
			"orders.py":
				"def compute_total(items):\n    return sum(price * qty for price, qty in items)\n",
			"report.py":
				"from orders import compute_total\n\n\ndef summary(items):\n    return f'Total: {compute_total(items)}'\n",
			"tests/__init__.py": "",
			"tests/test_report.py":
				"import unittest\n\nfrom report import summary\n\n\nclass ReportTest(unittest.TestCase):\n    def test_summary(self):\n        self.assertEqual(summary([(2, 3), (5, 1)]), 'Total: 11')\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
		},
		verify: [
			"set -e",
			"! grep -rn compute_total --include='*.py' .",
			"grep -q '^def calculate_total' orders.py",
			"grep -q calculate_total report.py",
			"python3 -m unittest discover -s tests -t . 2>&1 | tail -3",
		].join("\n"),
	},
	{
		id: "agents-rule",
		prompt:
			"Add greet.py with a function greet(name) that returns 'Hello, <name>!' (for example greet('Ada') returns 'Hello, Ada!').",
		files: {
			"AGENTS.md": `# Repository rules\n\nEvery new Python file must begin with this exact first line:\n\n${HEADER_RULE}\n`,
			"README.md": "Greeting fixture.\n",
		},
		verify: [
			"set -e",
			`[ "$(head -n 1 greet.py)" = '${HEADER_RULE}' ]`,
			`python3 -c "from greet import greet; assert greet('Ada') == 'Hello, Ada!'"`,
		].join("\n"),
	},
];

const PROMPT_SUFFIX =
	"\n\nWork directly in this repository: no plan proposal, child tasks, commits, pull requests or publishing. Stop when the change is done and checked.";

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		"max-cost": { type: "string" },
		models: { type: "string" },
		tasks: { type: "string" },
		concurrency: { type: "string", default: "5" },
		"turn-timeout": { type: "string", default: "300" },
		out: { type: "string" },
		price: { type: "string", multiple: true },
	},
});
const maxCost = Number(flags["max-cost"]);
if (!flags.live || !Number.isFinite(maxCost) || maxCost <= 0)
	throw new Error(
		"Refusing to run: pass --live and --max-cost <USD> (a positive spend cap).",
	);
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== DEV_REF ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF)
)
	throw new Error(
		"Refusing to run: DATABASE_URL is not the development project.",
	);
const models = (flags.models?.split(",") ?? DEFAULT_MODELS)
	.map((model) => model.trim())
	.filter(Boolean);
const tasks = flags.tasks
	? flags.tasks.split(",").map((id) => {
			const task = TASKS.find((candidate) => candidate.id === id.trim());
			if (!task)
				throw new Error(
					`Unknown task ${id}; choose from ${TASKS.map((t) => t.id).join(", ")}.`,
				);
			return task;
		})
	: TASKS;
const concurrency = Math.min(10, Math.max(1, Number(flags.concurrency) || 5));
const turnTimeoutMs =
	Math.min(900, Math.max(30, Number(flags["turn-timeout"]) || 300)) * 1000;
const outPath =
	flags.out ??
	`/tmp/model-smoke-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
const prices = { ...DEFAULT_PRICES };
for (const entry of flags.price ?? []) {
	const match = /^(.+)=([\d.]+):([\d.]+)$/.exec(entry);
	if (!match) throw new Error("--price expects model=input:output (USD/Mtok).");
	prices[match[1]] = [Number(match[2]), Number(match[3])];
}
const priceOf = (model: string) => prices[model] ?? UNKNOWN_PRICE;
const costOf = (model: string, input: number, output: number) => {
	const [inputPrice, outputPrice] = priceOf(model);
	return (input * inputPrice + output * outputPrice) / 1_000_000;
};
const reservation = (model: string) =>
	costOf(model, RESERVED_TOKENS.input, RESERVED_TOKENS.output);

process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
process.env.YTIMESY_MODEL_WORKFLOW_URL = ORIGIN;
process.env.YTIMESY_REALTIME_URL = ORIGIN;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const db = database();

type RunRecord = {
	model: string;
	task: string;
	state: string;
	completed: boolean;
	verifierPassed: boolean | null;
	verifierOutput: string | null;
	elapsedMs: number;
	toolCalls: number;
	failedToolCalls: number;
	failedByTool: Record<string, number>;
	toolsUsed: Record<string, number>;
	modelSteps: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	cacheHitPercent: number | null;
	estimatedCostUsd: number;
	errors: string[];
};

const liveVms = new Set<string>();
const liveSessions = new Map<string, string>();
let stopping = false;
let committedSpend = 0;
let reservedSpend = 0;
process.on("SIGINT", () => {
	if (stopping) process.exit(130);
	stopping = true;
	console.error(
		"Stopping: cancelling runs and cleaning up (Ctrl-C again to force).",
	);
});

const safe = (value: unknown) =>
	publicToolDetail(
		value instanceof Error ? value.message : String(value),
	).slice(0, 600);

async function turnState(sessionId: string) {
	return (
		await db.query<{ state: string; items: unknown; messages: unknown }>(
			"select t.state,s.items,t.messages from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
			[sessionId],
		)
	).rows[0];
}

function toolName(item: SessionItem) {
	switch (item.kind) {
		case "dynamicToolCall":
			return item.tool;
		case "commandExecution":
			return "command";
		case "fileChange":
			return "file_change";
		case "mcpToolCall":
			return `mcp:${item.tool}`;
		case "webSearch":
			return "web_search";
		default:
			return null;
	}
}

function measure(record: RunRecord, items: SessionItem[], messages: unknown) {
	record.toolCalls = 0;
	record.failedToolCalls = 0;
	record.failedByTool = {};
	record.toolsUsed = {};
	for (const item of items) {
		const name = toolName(item);
		if (!name) continue;
		record.toolCalls++;
		record.toolsUsed[name] = (record.toolsUsed[name] ?? 0) + 1;
		if ("status" in item && item.status === "failed") {
			record.failedToolCalls++;
			record.failedByTool[name] = (record.failedByTool[name] ?? 0) + 1;
		}
	}
	const usage = items.find((item) => item.kind === "userMessage")?.apiUsage;
	if (usage) {
		record.inputTokens = usage.inputTokens;
		record.outputTokens = usage.outputTokens;
		record.cachedTokens = usage.cacheReadTokens;
		record.cacheHitPercent =
			usage.inputTokens && usage.cacheReadTokens !== null
				? Math.round((usage.cacheReadTokens / usage.inputTokens) * 1000) / 10
				: null;
		record.estimatedCostUsd = costOf(
			record.model,
			usage.inputTokens ?? 0,
			usage.outputTokens ?? 0,
		);
	}
	if (Array.isArray(messages))
		record.modelSteps = messages.filter(
			(message) =>
				message && typeof message === "object" && message.role === "assistant",
		).length;
	record.errors = [
		...new Set([
			...record.errors,
			...items
				.filter((item) => item.kind === "error")
				.map((item) => safe(item.message)),
		]),
	];
}

const context = await (async () => {
	const owners = (
		await db.query<{ user_id: string }>(
			"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Requires one connected subscription owner.");
	const userId = owners[0].user_id;
	const source = (
		await db.query<{
			project_id: string;
			workspace_id: string;
			full_name: string;
		}>(
			"select s.project_id,s.workspace_id,p.full_name from agent_session s join project p on p.id=s.project_id where s.user_id=$1 and s.listed_model_id is not null order by s.updated_at desc limit 1",
			[userId],
		)
	).rows[0];
	if (!source) throw new Error("No project is configured for the owner.");
	const name = source.full_name.split("/")[1];
	if (!name || !/^[a-zA-Z0-9_.-]+$/.test(name))
		throw new Error("Invalid fixture directory name.");
	const gateways = (
		await db.query<{ id: string }>(
			"select id from model_connection where user_id=$1 and provider='openrouter'",
			[userId],
		)
	).rows;
	const catalog = models.some((model) => !model.startsWith("codex:"))
		? await apiModelCatalog(userId)
		: [];
	const routes = new Map<string, string>();
	for (const model of models) {
		if (model.startsWith("codex:")) {
			routes.set(model, model.slice("codex:".length));
			continue;
		}
		if (gateways.length !== 1)
			throw new Error("Requires exactly one saved OpenRouter connection.");
		const route = modelRouteId(gateways[0].id, model);
		if (!catalog.some((entry) => entry.id === route))
			throw new Error(`${model} is not in the connection's model catalog.`);
		routes.set(model, route);
	}
	return { userId, source, name, routes };
})();

async function preflightExecutor() {
	const url = `${ORIGIN}/start`;
	const body = JSON.stringify({ turnId: randomUUID(), leaseId: randomUUID() });
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(
				modelWorkflowSigningSecret(),
				"POST",
				url,
				body,
			),
			signal: AbortSignal.timeout(15_000),
		});
		if (response.status === 409) return;
		if (response.status !== 503)
			throw new Error(`Executor preflight failed (${response.status}).`);
		await delay(2000);
	}
	throw new Error("Executor gate is not open.");
}

async function runOne(model: string, task: Task): Promise<RunRecord> {
	const record: RunRecord = {
		model,
		task: task.id,
		state: "not-started",
		completed: false,
		verifierPassed: null,
		verifierOutput: null,
		elapsedMs: 0,
		toolCalls: 0,
		failedToolCalls: 0,
		failedByTool: {},
		toolsUsed: {},
		modelSteps: null,
		inputTokens: null,
		outputTokens: null,
		cachedTokens: null,
		cacheHitPercent: null,
		estimatedCostUsd: 0,
		errors: [],
	};
	const reserve = reservation(model);
	if (stopping) {
		record.state = "skipped";
		record.errors.push("Suite stopped before this run.");
		return record;
	}
	if (committedSpend + reservedSpend + reserve > maxCost) {
		record.state = "skipped";
		record.errors.push(
			`Cost cap: needs a $${reserve.toFixed(2)} reservation; cap $${maxCost}.`,
		);
		return record;
	}
	reservedSpend += reserve;
	const { userId, source, name } = context;
	const subscription = model.startsWith("codex:");
	const route = context.routes.get(model) as string;
	let sessionId: string | undefined;
	let vmId: string | undefined;
	const started = Date.now();
	try {
		const session = await insertAgentSession({
			userId,
			projectId: source.project_id,
			workspaceId: source.workspace_id,
			harness: subscription ? "codex" : "api",
			title: `Model smoke ${task.id}`,
			listedModelId: route,
		});
		sessionId = session.id;
		liveSessions.set(session.id, userId);
		const created = await client.vms.create({
			// Usage admission resolves the VM owner from this session-derived slug.
			slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			snapshotId: CHEAP_BASE_SNAPSHOT,
			firewall: GUEST_INTERNET_FIREWALL,
			ttlSeconds: Math.ceil(turnTimeoutMs / 1000) + 600,
			maxRunTotalSeconds: Math.ceil(turnTimeoutMs / 1000) + 300,
			idleTimeoutSeconds: 300,
			automaticRestart: false,
			metadata: { purpose: "ytimesy-model-smoke" },
		});
		vmId = created.vmId;
		liveVms.add(vmId);
		await saveAgentSessionProviderRef(session.id, vmId);
		const vm = await waitUntilVmRunning(created.vm, "Model smoke");
		if (vm.resources.cpu > 2 || vm.resources.memory > 4096)
			throw new Error("Smoke VM exceeds the cheap resource envelope.");
		const workspace = WorkspaceId(vmId);
		const home = (
			await machines.exec(workspace, 'printf %s "$HOME"', 15_000)
		).stdout.trim();
		if (!home.startsWith("/")) throw new Error("VM home is unavailable.");
		const dir = `${home}/${name}`;
		const directories = new Set(
			Object.keys(task.files)
				.filter((path) => path.includes("/"))
				.map((path) => `${dir}/${path.slice(0, path.lastIndexOf("/"))}`),
		);
		const mkdir = await machines.exec(
			workspace,
			`mkdir -p ${[dir, ...directories].map((path) => `'${path}'`).join(" ")}`,
			15_000,
		);
		if (mkdir.exitCode) throw new Error("Fixture directories failed.");
		for (const [path, content] of Object.entries(task.files))
			await machines.writeTextFile(workspace, `${dir}/${path}`, content);
		const setup = await machines.exec(
			workspace,
			`cd '${dir}' && git init -q && git add -A && git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm fixture && git update-ref refs/ytimesy/base HEAD && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
			20_000,
		);
		if (setup.exitCode) throw new Error("Fixture repository setup failed.");
		await db.query("update agent_session set status='ready' where id=$1", [
			session.id,
		]);
		const text = `${task.prompt}${PROMPT_SUFFIX}`;
		await withBackgroundJobDispatcher(
			async () => {},
			() =>
				subscription
					? sendSubscriptionTask(
							{ userId, projectId: source.project_id, sessionId: session.id },
							{ modelId: route, text },
						)
					: sendApiWorkspaceTask(
							{ userId, projectId: source.project_id, sessionId: session.id },
							{ modelId: route, text },
						),
		);
		const turnStarted = Date.now();
		let admitted = false;
		while (!admitted && Date.now() - turnStarted < 120_000 && !stopping) {
			const turn = await claimApiTurn(
				concurrency,
				64,
				"durable-object",
				session.id,
			);
			if (turn?.lease_id) {
				await dispatchModelWorkflow(turn);
				admitted = true;
				break;
			}
			const state = await turnState(session.id);
			if (state && state.state !== "queued") admitted = true;
			else await delay(2000);
		}
		if (!admitted) throw new Error("Turn was not admitted within two minutes.");
		const deadline = turnStarted + turnTimeoutMs;
		let cancelled = false;
		while (true) {
			const state = await turnState(session.id);
			const items = sessionItemsFromUnknown(state?.items);
			measure(record, items, state?.messages);
			record.state = state?.state ?? "missing";
			if (state && !["queued", "running"].includes(state.state)) break;
			const reason =
				record.estimatedCostUsd > reserve
					? "run exceeded its cost reservation"
					: Date.now() > deadline
						? `exceeded ${turnTimeoutMs / 1000}s`
						: stopping
							? "suite stopped"
							: null;
			if (reason && !cancelled) {
				cancelled = true;
				record.errors.push(`Cancelled: ${reason}.`);
				await cancelServerTurn(userId, session.id);
			}
			if (Date.now() > deadline + 60_000) {
				record.state = "unsettled";
				break;
			}
			await delay(2000);
		}
		record.elapsedMs = Date.now() - turnStarted;
		record.completed = record.state === "completed";
		const verified = await machines.exec(
			workspace,
			`cd '${dir}' && bash -c ${`'${task.verify.replaceAll("'", "'\\''")}'`}`,
			60_000,
		);
		record.verifierPassed = verified.exitCode === 0;
		record.verifierOutput = safe(
			`${verified.stdout}${verified.stderr}`.trim().slice(-400),
		);
	} catch (error) {
		record.errors.push(safe(error));
		if (!record.elapsedMs) record.elapsedMs = Date.now() - started;
	} finally {
		reservedSpend -= reserve;
		committedSpend += record.estimatedCostUsd;
		if (sessionId) await cancelServerTurn(userId, sessionId).catch(() => {});
		if (vmId) {
			const id = vmId;
			await client.vms
				.delete(id)
				.then(() => liveVms.delete(id))
				.catch(() => {});
		}
		if (sessionId) {
			const id = sessionId;
			await deleteAgentSessionForOwner(userId, id)
				.then(() => liveSessions.delete(id))
				.catch(() => {});
		}
	}
	return record;
}

function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
		)
		.join("\n");
}

const startedAt = new Date().toISOString();
const runs: RunRecord[] = [];
try {
	await preflightExecutor();
	const queue = models.flatMap((model) =>
		tasks.map((task) => ({ model, task })),
	);
	console.info(
		`Running ${queue.length} runs (${models.length} models x ${tasks.length} tasks), concurrency ${concurrency}, cap $${maxCost}.`,
	);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
			while (next < queue.length) {
				const { model, task } = queue[next++];
				const record = await runOne(model, task);
				runs.push(record);
				console.info(
					`${record.verifierPassed ? "PASS" : "FAIL"} ${model} ${task.id} ${record.state} ${(record.elapsedMs / 1000).toFixed(0)}s tools=${record.toolCalls} failed=${record.failedToolCalls}`,
				);
			}
		}),
	);
} finally {
	for (const [sessionId, userId] of liveSessions)
		await cancelServerTurn(userId, sessionId).catch(() => {});
	const leaked: string[] = [];
	for (const vmId of liveVms)
		await client.vms.delete(vmId).catch(() => leaked.push(`vm ${vmId}`));
	for (const [sessionId, userId] of liveSessions)
		await deleteAgentSessionForOwner(userId, sessionId).catch(() =>
			leaked.push(`session ${sessionId}`),
		);
	await closeDatabase();
	if (leaked.length) {
		console.error(`Cleanup incomplete: ${leaked.join(", ")}.`);
		process.exitCode = 1;
	}
}

const order = (record: RunRecord) =>
	models.indexOf(record.model) * 100 +
	tasks.findIndex((task) => task.id === record.task);
runs.sort((a, b) => order(a) - order(b));
const summary = models.map((model) => {
	const mine = runs.filter((run) => run.model === model);
	const failedByTool: Record<string, number> = {};
	for (const run of mine)
		for (const [tool, count] of Object.entries(run.failedByTool))
			failedByTool[tool] = (failedByTool[tool] ?? 0) + count;
	const sum = (pick: (run: RunRecord) => number | null) =>
		mine.reduce((total, run) => total + (pick(run) ?? 0), 0);
	const elapsed = mine.map((run) => run.elapsedMs).sort((a, b) => a - b);
	const input = sum((run) => run.inputTokens);
	return {
		model,
		runs: mine.length,
		completed: mine.filter((run) => run.completed).length,
		verified: mine.filter((run) => run.verifierPassed).length,
		medianSeconds: elapsed.length
			? Math.round(elapsed[Math.floor(elapsed.length / 2)] / 1000)
			: null,
		toolCalls: sum((run) => run.toolCalls),
		failedToolCalls: sum((run) => run.failedToolCalls),
		failedByTool,
		modelSteps: sum((run) => run.modelSteps),
		inputTokens: input,
		outputTokens: sum((run) => run.outputTokens),
		cacheHitPercent: input
			? Math.round((sum((run) => run.cachedTokens) / input) * 1000) / 10
			: null,
		estimatedCostUsd:
			Math.round(sum((run) => run.estimatedCostUsd) * 1e4) / 1e4,
	};
});
console.info(
	`\n${table([
		[
			"model",
			"task",
			"state",
			"verify",
			"secs",
			"tools",
			"failed",
			"steps",
			"in",
			"out",
			"cache%",
			"usd",
		],
		...runs.map((run) => [
			run.model,
			run.task,
			run.state,
			run.verifierPassed === null ? "-" : run.verifierPassed ? "pass" : "FAIL",
			(run.elapsedMs / 1000).toFixed(0),
			String(run.toolCalls),
			run.failedToolCalls
				? `${run.failedToolCalls} (${Object.entries(run.failedByTool)
						.map(([tool, count]) => `${tool}:${count}`)
						.join(",")})`
				: "0",
			String(run.modelSteps ?? "-"),
			String(run.inputTokens ?? "-"),
			String(run.outputTokens ?? "-"),
			String(run.cacheHitPercent ?? "-"),
			run.estimatedCostUsd.toFixed(3),
		]),
	])}\n\n${table([
		[
			"model",
			"verified",
			"completed",
			"median s",
			"tools",
			"failed",
			"steps",
			"cache%",
			"usd",
		],
		...summary.map((row) => [
			row.model,
			`${row.verified}/${row.runs}`,
			`${row.completed}/${row.runs}`,
			String(row.medianSeconds ?? "-"),
			String(row.toolCalls),
			String(row.failedToolCalls),
			String(row.modelSteps),
			String(row.cacheHitPercent ?? "-"),
			row.estimatedCostUsd.toFixed(3),
		]),
	])}`,
);
for (const run of runs)
	if (run.errors.length)
		console.info(`errors ${run.model} ${run.task}: ${run.errors.join(" | ")}`);
await writeFile(
	outPath,
	`${JSON.stringify(
		{
			startedAt,
			finishedAt: new Date().toISOString(),
			config: {
				models,
				tasks: tasks.map((task) => task.id),
				concurrency,
				turnTimeoutSeconds: turnTimeoutMs / 1000,
				maxCostUsd: maxCost,
				prices: Object.fromEntries(
					models.map((model) => [model, priceOf(model)]),
				),
			},
			summary,
			runs,
		},
		null,
		2,
	)}\n`,
);
console.info(`\nWrote ${outPath}`);
if (runs.some((run) => !run.verifierPassed)) process.exitCode = 1;
