// Shared pieces of the development-only builder smoke runs: the fixture tasks
// with their deterministic verifiers, and a runner that executes one task as a
// single ROOT builder turn on a disposable VM against the development edge.
// Used by scripts/model-smoke-suite.ts and scripts/native-vs-harness.ts.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../../src/domain/delivery-auth";
import { WorkspaceId } from "../../src/domain/ids";
import { modelRouteId } from "../../src/domain/model-connection";
import {
	type SessionItem,
	sessionItemsFromUnknown,
} from "../../src/domain/session-item";
import { publicToolDetail } from "../../src/domain/tool-detail";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../../src/server/adapters/database";
import { GUEST_INTERNET_FIREWALL } from "../../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../../src/server/adapters/freestyle/workspace-machines";
import { loadModelConnection } from "../../src/server/adapters/model-connections";
import {
	dispatchModelWorkflow,
	modelWorkflowSigningSecret,
} from "../../src/server/adapters/model-workflow-dispatch";
import { workspaceBootSnapshotId } from "../../src/server/records/tools-snapshot-store";
import {
	apiModelCatalog,
	sendApiWorkspaceTask,
} from "../../src/server/services/api-workspace-session";
import { cancelServerTurn } from "../../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../../src/server/services/codex-subscription-session";
import { connectionApiKey } from "../../src/server/services/model-connections";
import { type EvalUser, SLOT_LIMITS, withSlot } from "./eval-user";

export { assertDevelopmentDatabase } from "./eval-user";

const ORIGIN =
	"https://ytimesy-edge-executor-development.hetkp8044.workers.dev";

export type Task = {
	id: string;
	prompt: string;
	files: Record<string, string>;
	verify: string;
	/** The run fails unless the turn made at least this many tool calls. */
	minToolCalls?: number;
	/** Left out of the default task list (keeps earlier results comparable). */
	onlyWhenNamed?: boolean;
};

const HEADER_RULE = "# owner: smoke-team";
export const TASKS: Task[] = [
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
			"set -eo pipefail\ngit diff --quiet HEAD -- tests\npython3 -m unittest discover -s tests -t . 2>&1 | tail -3",
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
			"set -eo pipefail\ngit diff --quiet HEAD -- tests\npython3 -m unittest discover -s tests -t . 2>&1 | tail -3",
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
			"set -eo pipefail",
			"! grep -rn compute_total --include='*.py' .",
			"grep -q '^def calculate_total' orders.py",
			"grep -q calculate_total report.py",
			"python3 -m unittest discover -s tests -t . 2>&1 | tail -3",
		].join("\n"),
	},
	{
		// Two dependent tool calls: the second needs the first one's result,
		// so the model must carry a tool result (and its reasoning) across steps.
		id: "two-tool-calls",
		prompt:
			"START.md names the file that holds a value. Read it, follow the pointer, and write only that value to answer.txt.",
		files: {
			"START.md":
				"The value you need is in the file named on the next line.\nvault/b7/delta.txt\n",
			"vault/a3/alpha.txt": "slate-heron-41\n",
			"vault/b7/delta.txt": "ochre-falcon-29\n",
			"vault/c9/gamma.txt": "amber-lynx-73\n",
		},
		verify: 'set -e\n[ "$(tr -d "[:space:]" < answer.txt)" = ochre-falcon-29 ]',
		minToolCalls: 2,
		onlyWhenNamed: true,
	},
	{
		// Exercises a builder surface end to end: a background server it must
		// start and stop, an edit, a new file and a clean-copy deliverable check.
		id: "lean-smoke",
		prompt:
			"Two things. 1) Fix the bug in pager.py so `python3 -m unittest discover -s tests -t .` passes (do not modify tests). 2) Create serve.py: `python3 serve.py <port>` runs an HTTP server whose GET /health answers 200 with the body `ok`. Start it as a background process on port 8765 and keep it running while you run the unit tests as a separate step; then, in another step, confirm /health responds, and finally stop that server so nothing is left listening on 8765. Another team will run serve.py on its own, so check it from a clean copy before finishing.",
		files: {
			"pager.py":
				'def page(items, number, size):\n    """Items on 1-based page `number` of `size` items each."""\n    start = (number - 1) * size\n    return items[start : start + size + 1]\n',
			"tests/__init__.py": "",
			"tests/test_pager.py":
				"import unittest\n\nfrom pager import page\n\n\nclass PagerTest(unittest.TestCase):\n    def test_middle_page(self):\n        self.assertEqual(page(list(range(1, 11)), 2, 3), [4, 5, 6])\n\n    def test_last_page(self):\n        self.assertEqual(page(list(range(1, 11)), 4, 3), [10])\n\n\nif __name__ == '__main__':\n    unittest.main()\n",
		},
		verify: [
			"set -eo pipefail",
			"git diff --quiet HEAD -- tests",
			"python3 -m unittest discover -s tests -t . 2>&1 | tail -3",
			`! python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=2)" 2>/dev/null || { echo 'server still listening on 8765'; exit 1; }`,
			"python3 serve.py 8799 >/tmp/smoke-serve.log 2>&1 & pid=$!",
			`for _ in $(seq 1 25); do body=$(python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8799/health', timeout=1).read().decode().strip())" 2>/dev/null) && break; sleep 0.2; done`,
			"kill $pid 2>/dev/null || true",
			'[ "$body" = ok ] || { echo "serve.py /health gave: $body"; exit 1; }',
		].join("\n"),
		onlyWhenNamed: true,
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

const safeName = (value: string) => value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");

export const PROMPT_SUFFIX =
	"\n\nWork directly in this repository: no plan proposal, child tasks, commits, pull requests or publishing. Stop when the change is done and checked.";

export function selectTasks(ids: string | undefined) {
	return ids
		? ids.split(",").map((id) => {
				const task = TASKS.find((candidate) => candidate.id === id.trim());
				if (!task)
					throw new Error(
						`Unknown task ${id}; choose from ${TASKS.map((t) => t.id).join(", ")}.`,
					);
				return task;
			})
		: TASKS.filter((task) => !task.onlyWhenNamed);
}

/** Shell command that turns the fixture files in `dir` into a one-commit repo. */
export const fixtureRepoScript = (dir: string) =>
	`cd '${dir}' && git init -q && git add -A && git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm fixture && git update-ref refs/ytimesy/base HEAD`;

export const verifierCommand = (task: Task) =>
	`bash -c ${`'${task.verify.replaceAll("'", "'\\''")}'`}`;

export type RunRecord = {
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

export const emptyRecord = (model: string, task: string): RunRecord => ({
	model,
	task,
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
});

export const safe = (value: unknown) =>
	publicToolDetail(
		value instanceof Error ? value.message : String(value),
	).slice(0, 600);

export const percent = (part: number, whole: number) =>
	whole ? Math.round((part / whole) * 1000) / 10 : null;

export function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
		)
		.join("\n");
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

export async function createHarnessRunner(options: {
	/** Who runs the sessions: a throwaway eval user (or the owner). */
	user: EvalUser;
	models: string[];
	concurrency: number;
	turnTimeoutMs: number;
	costOf: (model: string, input: number, output: number) => number;
	/** Reasoning effort for subscription turns; the model default when unset. */
	reasoning?: string;
}) {
	const { concurrency, turnTimeoutMs, costOf } = options;
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
	const liveVms = new Set<string>();
	const liveSessions = new Map<string, string>();
	let stopping = false;

	async function turnState(sessionId: string) {
		return (
			await db.query<{ state: string; items: unknown; messages: unknown }>(
				"select t.state,s.items,t.messages from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
				[sessionId],
			)
		).rows[0];
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
					? percent(usage.cacheReadTokens, usage.inputTokens)
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
					message &&
					typeof message === "object" &&
					message.role === "assistant",
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

	// Development diagnostics: YTIMESY_SMOKE_TRANSCRIPTS=<dir> keeps each run's
	// stored items, model messages and a probe of the VM's workspace commands
	// (lean surfaces) before the session and VM are deleted.
	const transcriptDir = process.env.YTIMESY_SMOKE_TRANSCRIPTS;
	let transcriptCount = 0;
	async function writeTranscript(
		record: RunRecord,
		sessionId: string,
		workspace: WorkspaceId,
		taskId: string,
	) {
		if (!transcriptDir) return;
		try {
			const state = await turnState(sessionId);
			const probe = await machines
				.exec(
					workspace,
					"export PATH=\"$HOME/.ytimesy/bin:$PATH\"; echo '# ~/.ytimesy'; ls -A ~/.ytimesy 2>&1; echo '# commands'; for c in ytimesy-check ytimesy-job ytimesy-browser; do command -v $c || echo \"missing $c\"; done; echo '# history'; ls ~/.ytimesy/history 2>&1 | head; echo '# processes'; ps -eo pid,etimes,args | grep -E 'serve|http|python|node' | grep -v grep | head",
					20_000,
				)
				.catch((error) => ({ stdout: "", stderr: safe(error), exitCode: -1 }));
			await mkdir(transcriptDir, { recursive: true });
			await writeFile(
				`${transcriptDir}/${safeName(record.model)}-${taskId}-${process.pid}-${++transcriptCount}.json`,
				JSON.stringify(
					{
						record,
						items: state?.items,
						messages: state?.messages,
						probe: `${probe.stdout}${probe.stderr}`,
					},
					null,
					1,
				),
			);
		} catch (error) {
			console.warn("Transcript was not written:", safe(error));
		}
	}

	const { user } = options;
	const context = await (async () => {
		const userId = user.userId;
		const source = {
			project_id: user.project.projectId,
			workspace_id: user.project.workspaceId,
		};
		const name = user.project.dirName;
		const gatewayId = user.openRouterConnectionId;
		const catalog = options.models.some((model) => !model.startsWith("codex:"))
			? await apiModelCatalog(userId)
			: [];
		const routes = new Map<string, string>();
		for (const model of options.models) {
			if (model.startsWith("codex:")) {
				routes.set(model, model.slice("codex:".length));
				continue;
			}
			if (!gatewayId)
				throw new Error(
					"Requires exactly one saved OpenRouter connection on the owner.",
				);
			const route = modelRouteId(gatewayId, model);
			if (!catalog.some((entry) => entry.id === route))
				throw new Error(
					`${model} is not in the connection's model catalog.${
						model.endsWith(":free")
							? " Free models need YTIMESY_DEV_ALLOW_ANY_MODEL=1, and the saved OpenRouter connection's catalog must list the model (re-save the connection to refresh it)."
							: ""
					}`,
				);
			routes.set(model, route);
		}
		return { userId, source, name, routes, gatewayId };
	})();

	/**
	 * The saved OpenRouter key's status: its limit and today's `:free` request
	 * allowance (GET /key, UTC day) and the account's unspent credit (GET
	 * /credits), or null when unavailable. Read only; never inference.
	 */
	async function openRouterKeyStatus(): Promise<{
		free: { used: number; limit: number; remaining: number } | null;
		/** USD left under the key's limit (null: no limit set). */
		limitRemaining: number | null;
		/** USD spent on the key (all time). */
		usage: number | null;
		/** USD of purchased account credit not yet spent. */
		accountCredit: number | null;
	} | null> {
		if (!context.gatewayId) return null;
		const connection = await loadModelConnection(
			context.userId,
			context.gatewayId,
		);
		if (!connection || new URL(connection.baseUrl).hostname !== "openrouter.ai")
			return null;
		const headers = {
			Authorization: `Bearer ${await connectionApiKey(context.userId, connection)}`,
		};
		const response = await fetch(`${connection.baseUrl}/key`, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		const credits = (await fetch(`${connection.baseUrl}/credits`, {
			headers,
			signal: AbortSignal.timeout(15_000),
		})
			.then((reply) => (reply.ok ? reply.json() : null))
			.catch(() => null)) as {
			data?: { total_credits?: unknown; total_usage?: unknown };
		} | null;
		const body = (await response.json()) as {
			data?: {
				free_model_daily_requests?: Record<string, unknown>;
				limit_remaining?: unknown;
				usage?: unknown;
			};
		};
		const quota = body.data?.free_model_daily_requests;
		const { used, limit, remaining } = quota ?? {};
		const number = (value: unknown) =>
			typeof value === "number" && Number.isFinite(value) ? value : null;
		return {
			free:
				typeof used === "number" &&
				typeof limit === "number" &&
				typeof remaining === "number"
					? { used, limit, remaining }
					: null,
			limitRemaining: number(body.data?.limit_remaining),
			usage: number(body.data?.usage),
			accountCredit: (() => {
				const total = number(credits?.data?.total_credits);
				const used = number(credits?.data?.total_usage);
				return total === null || used === null ? null : total - used;
			})(),
		};
	}

	/** Today's `:free` request allowance, or null when OpenRouter does not report it. */
	async function openRouterFreeQuota() {
		return (await openRouterKeyStatus())?.free ?? null;
	}

	async function preflightExecutor() {
		const url = `${ORIGIN}/start`;
		const body = JSON.stringify({
			turnId: randomUUID(),
			leaseId: randomUUID(),
		});
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

	/**
	 * Runs one task; a run whose recorded spend passes `reserveUsd` is
	 * cancelled. Rate-limited routes wait for a slot shared by every eval
	 * process on this machine.
	 */
	function runOne(model: string, task: Task, reserveUsd: number) {
		const slot = model.startsWith("codex:")
			? (["codex", SLOT_LIMITS.codex] as const)
			: model.endsWith(":free")
				? (["openrouter-free", SLOT_LIMITS.openRouterFree] as const)
				: null;
		return slot
			? withSlot(
					slot[0],
					slot[1],
					() => runOneNow(model, task, reserveUsd),
					() => stopping,
				).catch((error) => {
					const record = emptyRecord(model, task.id);
					record.state = "skipped";
					record.errors.push(safe(error));
					return record;
				})
			: runOneNow(model, task, reserveUsd);
	}

	async function runOneNow(
		model: string,
		task: Task,
		reserveUsd: number,
	): Promise<RunRecord> {
		const record = emptyRecord(model, task.id);
		if (stopping) {
			record.state = "skipped";
			record.errors.push("Run stopped before this task.");
			return record;
		}
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
				snapshotId: await workspaceBootSnapshotId(),
				firewall: GUEST_INTERNET_FIREWALL,
				ttlSeconds: Math.ceil(turnTimeoutMs / 1000) + 600,
				maxRunTotalSeconds: Math.ceil(turnTimeoutMs / 1000) + 300,
				idleTimeoutSeconds: 300,
				automaticRestart: false,
				metadata: { purpose: "ytimesy-model-smoke" },
			});
			vmId = created.vmId;
			liveVms.add(vmId);
			await user.trackVm(vmId);
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
				`${fixtureRepoScript(dir)} && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
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
								{
									userId,
									projectId: source.project_id,
									sessionId: session.id,
								},
								{ modelId: route, text, variant: options.reasoning },
							)
						: sendApiWorkspaceTask(
								{
									userId,
									projectId: source.project_id,
									sessionId: session.id,
								},
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
			if (!admitted)
				throw new Error("Turn was not admitted within two minutes.");
			const deadline = turnStarted + turnTimeoutMs;
			let cancelled = false;
			while (true) {
				const state = await turnState(session.id);
				const items = sessionItemsFromUnknown(state?.items);
				measure(record, items, state?.messages);
				record.state = state?.state ?? "missing";
				if (state && !["queued", "running"].includes(state.state)) break;
				const reason =
					record.estimatedCostUsd > reserveUsd
						? "run exceeded its cost reservation"
						: Date.now() > deadline
							? `exceeded ${turnTimeoutMs / 1000}s`
							: stopping
								? "run stopped"
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
			if (transcriptDir)
				await writeTranscript(record, session.id, workspace, task.id);
			const verified = await machines.exec(
				workspace,
				`cd '${dir}' && ${verifierCommand(task)}`,
				60_000,
			);
			record.verifierPassed = verified.exitCode === 0;
			record.verifierOutput = safe(
				`${verified.stdout}${verified.stderr}`.trim().slice(-400),
			);
			if (task.minToolCalls && record.toolCalls < task.minToolCalls) {
				record.verifierPassed = false;
				record.verifierOutput = `${record.verifierOutput} (needs ${task.minToolCalls}+ tool calls; made ${record.toolCalls})`;
			}
		} catch (error) {
			record.errors.push(safe(error));
			if (!record.elapsedMs) record.elapsedMs = Date.now() - started;
		} finally {
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

	/** Cancels and deletes anything still live; returns what could not be removed. */
	async function cleanup() {
		for (const [sessionId, userId] of liveSessions)
			await cancelServerTurn(userId, sessionId).catch(() => {});
		const leaked: string[] = [];
		for (const vmId of liveVms)
			await client.vms.delete(vmId).catch(() => leaked.push(`vm ${vmId}`));
		for (const [sessionId, userId] of liveSessions)
			await deleteAgentSessionForOwner(userId, sessionId).catch(() =>
				leaked.push(`session ${sessionId}`),
			);
		// The eval user and everything it still owns (no-op for the owner).
		leaked.push(...(await user.release()));
		await closeDatabase();
		return leaked;
	}

	return {
		runOne,
		preflightExecutor,
		openRouterFreeQuota,
		openRouterKeyStatus,
		cleanup,
		stop: () => {
			stopping = true;
		},
	};
}
