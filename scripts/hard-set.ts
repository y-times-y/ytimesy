// Development-only hard evaluation set (docs/hard-set.md): Terminal-Bench 4.0
// tasks run through the ytimesy builder on the development edge, one
// throwaway eval user and one workspace VM per task, the task's environment
// in Docker on that VM, and the task's own tests on a second (grader) VM.
// Not the official harness: never report its numbers as Terminal-Bench scores.
//
// node --env-file=.env --import tsx scripts/hard-set.ts --list
// node --env-file=.env --import tsx scripts/hard-set.ts --live --run <name> --chunk 1
// node --env-file=.env --import tsx scripts/hard-set.ts --collect --run <name>
// node --env-file=.env --import tsx scripts/hard-set.ts --report --run <name>
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { Freestyle } from "freestyle";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import {
	attemptCostFromRun,
	formatCostSummary,
	runListPrice,
	costSummary as sharedCostSummary,
} from "../src/domain/eval-cost";
import {
	harnessVariantFromFlags,
	harnessVariantLabel,
} from "../src/domain/harness-variant";
import { WorkspaceId } from "../src/domain/ids";
import { modelRouteId } from "../src/domain/model-connection";
import { sessionItemsFromUnknown } from "../src/domain/session-item";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { subscriptionFetch } from "../src/server/adapters/codex-subscription-transport";
import { closeDatabase, database } from "../src/server/adapters/database";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import {
	dispatchModelWorkflow,
	modelWorkflowSigningSecret,
} from "../src/server/adapters/model-workflow-dispatch";
import { workspaceBootSnapshotId } from "../src/server/records/tools-snapshot-store";
import { sendApiWorkspaceTask } from "../src/server/services/api-workspace-session";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";
import {
	graderPullScript,
	loadTaskEnvironment,
	oracleScript,
	parseReward,
	setupFiles,
	stageScript,
	type TaskEnvironment,
	verifyScript,
} from "./hard-set/environment";
import {
	DEFAULT_GEMINI_KEY_FILE,
	geminiConnectionModels,
	probeGeminiQuota,
	readGeminiKey,
} from "./hard-set/gemini";
import { type HardSetRecord, isScored } from "./hard-set/records";
import { hardSetRoute, quotaStop, recordPricing } from "./hard-set/route";
import { HARD_SET, HARD_SET_CHUNKS, type HardSetTask } from "./hard-set/tasks";
import {
	assertDevelopmentDatabase,
	emptyRecord,
	measureRun,
	safe,
	table,
	turnState,
} from "./smoke/builder-harness";
import {
	createEvalUser,
	type EvalUser,
	onEvalStop,
	SLOT_LIMITS,
	subscriptionOwner,
	withSlot,
} from "./smoke/eval-user";

const DEFAULT_DATASET = resolve("../cloud/.ytimesy/tb4-dataset");
const RUNS = resolve(".ytimesy/hard-set");
// Wall-time reserve after the agent: cancel/settle, staging, artifact transfer.
const AFTER_AGENT_RESERVE_SEC = 75;
// A grader VM lives at most this long (its tests may outlast the invocation;
// --collect reads the result and deletes it).
const GRADER_LIFETIME_SEC = 45 * 60;

const { values: flags } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		list: { type: "boolean", default: false },
		collect: { type: "boolean", default: false },
		report: { type: "boolean", default: false },
		/** Groups the chunks of one pass; results go to .ytimesy/hard-set/<run>/. */
		run: { type: "string" },
		tasks: { type: "string" },
		/** 1-based chunk number from HARD_SET_CHUNKS (comma-separated for several). */
		chunk: { type: "string" },
		/** agent (default), oracle (reference solution, expect 1) or nop (no agent, expect 0). */
		mode: { type: "string", default: "agent" },
		/** A Codex model id (subscription) or google/<model> (Gemini API key). */
		model: { type: "string", default: "gpt-6.1-sol" },
		/** The Gemini key file for google/<model> runs (never printed). */
		"google-key-file": { type: "string", default: DEFAULT_GEMINI_KEY_FILE },
		/** Reasoning effort for the subscription turn; the model default when unset. */
		reasoning: { type: "string" },
		variant: { type: "string", multiple: true },
		/** Agent time per task (minutes). */
		"agent-minutes": { type: "string", default: "7" },
		/** Wall-time ceiling for this invocation (minutes, at most 10). */
		"max-minutes": { type: "string", default: "10" },
		/** Tasks run at once (default: all selected, at most the Codex slots). */
		concurrency: { type: "string" },
		dataset: { type: "string", default: DEFAULT_DATASET },
		/** Keep each agent run's stored items and model messages (run directory). */
		transcripts: { type: "boolean", default: false },
	},
});

// Cost comes from the shared eval-cost helper (src/domain/eval-cost.ts) at
// the model's list price in src/domain/model-pricing.ts. Our runs use the
// Codex subscription, so it is what the same tokens would cost on the API,
// labelled as an estimate, not what the run cost.

/** API cost of a record's tokens at list price; null without tokens or a price. */
function estimatedCost(record: HardSetRecord) {
	if (record.inputTokens === null || record.inputTokens === undefined)
		return null;
	return runListPrice({
		...recordPricing(record.model),
		inputTokens: record.inputTokens,
		cachedTokens: record.cachedTokens ?? null,
		outputTokens: record.outputTokens ?? null,
	}).costUsd;
}

const usd = (value: number | null) =>
	value === null ? "-" : `$${value.toFixed(value < 1 ? 3 : 2)}`;

/** Cost per attempt and per solved task over scored agent records. */
function costSummary(records: HardSetRecord[]) {
	const attempts = records
		.filter((record) => estimatedCost(record) !== null)
		.map((record) => ({
			...attemptCostFromRun({ ...record, verifierPassed: record.passed }),
			costUsd: estimatedCost(record),
			estimated: true,
		}));
	if (!attempts.length) return null;
	return `Cost: ${formatCostSummary(sharedCostSummary(attempts))}.`;
}

const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const seconds = (from: number) => Math.round((Date.now() - from) / 1000);

function selectedTasks(): HardSetTask[] {
	if (flags.tasks && flags.chunk)
		throw new Error("Pass --tasks or --chunk, not both.");
	const ids = flags.tasks
		? flags.tasks.split(",").map((id) => id.trim())
		: flags.chunk
			? flags.chunk.split(",").flatMap((value) => {
					const chunk = HARD_SET_CHUNKS[Number(value) - 1];
					if (!chunk)
						throw new Error(
							`Unknown chunk ${value}; choose 1-${HARD_SET_CHUNKS.length}.`,
						);
					return chunk;
				})
			: null;
	if (!ids)
		throw new Error("Choose tasks with --tasks or --chunk (see --list).");
	return ids.map((id) => {
		const task = HARD_SET.find((candidate) => candidate.id === id);
		if (!task)
			throw new Error(
				`${id} is not in the hard set; see --list (scripts/hard-set/tasks.ts).`,
			);
		return task;
	});
}

function runDirectory() {
	const run = flags.run;
	if (!run || !/^[A-Za-z0-9._=-]{1,80}$/.test(run))
		throw new Error(
			"Pass --run <name> (letters, digits, . _ = -): one name per pass, shared by its chunks.",
		);
	return join(RUNS, run);
}

async function readRecords(dir: string) {
	const files = (await readdir(dir).catch(() => [] as string[])).filter(
		(file) => file.endsWith(".json") && !file.endsWith(".transcript.json"),
	);
	return Promise.all(
		files.map(
			async (file) =>
				JSON.parse(await readFile(join(dir, file), "utf8")) as HardSetRecord,
		),
	);
}

const saveRecord = (dir: string, record: HardSetRecord) =>
	writeFile(
		join(dir, `${record.task}.${record.attempt}.json`),
		`${JSON.stringify(record, null, 2)}\n`,
	);

function printTable(records: HardSetRecord[]) {
	console.log(
		table([
			[
				"task",
				"cat",
				"pass",
				"reward",
				"state",
				"agent s",
				"budget s",
				"setup s",
				"grade s",
				"in tok",
				"out tok",
				"cached",
				"steps",
				"tools",
				"est $",
			],
			...records.map((record) => [
				`${record.task}.${record.attempt}`,
				record.category,
				record.status === "grading" ? "..." : record.passed ? "PASS" : "fail",
				record.reward === null ? "-" : String(record.reward),
				record.usageLimit
					? "usage-limit"
					: record.status === "grading"
						? "grading"
						: record.state,
				String(record.agentSec),
				String(record.agentBudgetSec),
				String(record.setupSec),
				String(record.gradeSec),
				String(record.inputTokens ?? "-"),
				String(record.outputTokens ?? "-"),
				String(record.cachedTokens ?? "-"),
				String(record.modelSteps ?? "-"),
				String(record.toolCalls),
				usd(estimatedCost(record)),
			]),
		]),
	);
}

if (flags.list) {
	const rows = [["chunk", "task", "category", "tb4 ours", "codex", "bucket"]];
	HARD_SET_CHUNKS.forEach((chunk, index) => {
		for (const id of chunk) {
			const task = HARD_SET.find((candidate) => candidate.id === id);
			if (!task) throw new Error(`Chunk lists unknown task ${id}.`);
			rows.push([
				String(index + 1),
				id,
				task.category,
				`${task.tb4.passes}/${task.tb4.trials}`,
				`${task.codex.passes}/${task.codex.trials}`,
				task.bucket.slice(0, 70),
			]);
		}
	});
	console.log(table(rows));
	process.exit(0);
}

if (flags.report) {
	const dir = runDirectory();
	const records = (await readRecords(dir)).sort((a, b) =>
		`${a.task}.${a.attempt}`.localeCompare(`${b.task}.${b.attempt}`),
	);
	printTable(records);
	const scored = records.filter(isScored);
	const byCategory = (category: string) => {
		const list = scored.filter((record) => record.category === category);
		return `${category} ${list.filter((record) => record.passed).length}/${list.length}`;
	};
	console.log(
		`\nRun ${flags.run}: ${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed (${byCategory("hard")}, ${byCategory("time-pressure")}, ${byCategory("control")}); ${records.length - scored.length} not scored (grading, skipped, usage limit, short budget or no reward).`,
	);
	const cost = costSummary(scored.filter((record) => record.mode === "agent"));
	if (cost) console.log(cost);
	for (const record of records.filter((record) => !isScored(record)))
		console.log(
			`- ${record.task}.${record.attempt}: ${record.status} ${record.state} budget ${record.agentBudgetSec}/${record.agentRequestedSec}s ${[...record.errors, record.gradeError].filter(Boolean).join(" | ").slice(0, 300)}`,
		);
	process.exit(0);
}

const maxMinutes = Number(flags["max-minutes"]);
if (!(maxMinutes > 0 && maxMinutes <= 10))
	throw new Error("--max-minutes must be in (0, 10]: the owner's limit.");
const invocationStart = Date.now();
const invocationDeadline = invocationStart + maxMinutes * 60_000;
// Grader VMs belong to no user, so the local VM calls skip usage admission
// (as the smoke suite's do); the edge still admits the agent VMs it uses.
process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const runDir = runDirectory();
await mkdir(runDir, { recursive: true });

async function execOk(vm: string, command: string, ms: number) {
	const result = await machines.exec(WorkspaceId(vm), command, ms);
	if (result.exitCode)
		throw new Error(
			`VM command failed (${result.exitCode}): ${`${result.stdout}${result.stderr}`.slice(-800)}`,
		);
	return result.stdout;
}

/** Starts a root script on the VM, detached; output and exit code land in /tb/<name>.log/.exit. */
async function startDetached(vm: string, script: string, name: string) {
	await machines.writeTextFile(WorkspaceId(vm), `/tb/${name}.sh`, script);
	await execOk(
		vm,
		`sudo rm -f /tb/${name}.exit /tb/${name}.log; sudo nohup setsid bash -c 'bash /tb/${name}.sh > /tb/${name}.log 2>&1; echo $? > /tb/${name}.exit' >/dev/null 2>&1 &`,
		20_000,
	);
}

/** Waits for a detached script until `until`; null while it is still running. */
async function waitDetached(vm: string, name: string, until: number) {
	while (true) {
		const done = await machines
			.exec(WorkspaceId(vm), `cat /tb/${name}.exit 2>/dev/null`, 15_000)
			.catch(() => null);
		if (done?.stdout.trim()) {
			const log = (
				await machines.exec(WorkspaceId(vm), `cat /tb/${name}.log`, 15_000)
			).stdout;
			return { exit: Number(done.stdout.trim()), log };
		}
		if (Date.now() > until) return null;
		await delay(3000);
	}
}

async function runDetached(
	vm: string,
	script: string,
	name: string,
	timeoutSec: number,
) {
	await startDetached(vm, script, name);
	return (
		(await waitDetached(vm, name, Date.now() + timeoutSec * 1000)) ?? {
			exit: 124,
			log: `${
				(
					await machines
						.exec(WorkspaceId(vm), `tail -c 2000 /tb/${name}.log`, 15_000)
						.catch(() => ({ stdout: "" }))
				).stdout
			}\n(timed out after ${Math.round(timeoutSec)}s)`,
		}
	);
}

/** Uploads a local directory to the VM as <remote>.tgz, unpacked at `remote`. */
async function uploadDirectory(vm: string, local: string, remote: string) {
	const scratch = await mkdtemp(join(tmpdir(), "hard-set-"));
	try {
		const archive = join(scratch, "upload.tgz");
		execFileSync("tar", ["-czf", archive, "-C", local, "."]);
		await client.vms
			.ref(vm)
			.fs.writeFile(`${remote}.tgz`, new Uint8Array(await readFile(archive)));
		await execOk(
			vm,
			`sudo rm -rf ${sh(remote)} && sudo mkdir -p ${sh(remote)} && sudo tar -xzf ${sh(`${remote}.tgz`)} -C ${sh(remote)}`,
			120_000,
		);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Reads a grader VM's result into its record; deletes the VM once read. */
async function finishGrading(record: HardSetRecord, until: number) {
	const vm = record.graderVmId as string;
	const done = await waitDetached(vm, "verify", until).catch(
		(error: unknown) => ({ exit: -1, log: `GRADE_ERROR ${safe(error)}` }),
	);
	const started = Date.parse(record.gradeStartedAt ?? "") || Date.now();
	if (!done) {
		// Give up only when the grader answers and still has no result long
		// after its timeout; an unreachable VM (our network, a sleeping
		// laptop) stays pending for the next --collect.
		const reachable = await machines
			.exec(WorkspaceId(vm), "test -f /tb/verify.sh", 15_000)
			.then((result) => result.exitCode === 0)
			.catch(() => false);
		if (
			reachable &&
			Date.now() - started > ((record.gradeTimeoutSec ?? 900) + 300) * 1000
		) {
			record.status = "error";
			record.gradeError = "Grader never finished.";
			await client.vms.delete(vm).catch(() => {});
			record.graderVmId = null;
		}
		return record;
	}
	const parsed = parseReward(done.log);
	record.gradeSec = Math.round((Date.now() - started) / 1000);
	record.reward = parsed.reward;
	record.testsExit = parsed.testsExit;
	record.testsTail = parsed.tail.slice(-800);
	record.gradeError =
		parsed.error ??
		(parsed.reward === null
			? `no reward (grader exit ${done.exit}): ${safe(done.log.slice(-400))}`
			: null);
	record.passed = parsed.reward === 1;
	record.verifierPassed = record.passed;
	record.status = "final";
	await client.vms.delete(vm).catch(() => {});
	record.graderVmId = null;
	return record;
}

if (flags.collect) {
	// Reads the result of every grader still running for this run.
	const pending = (await readRecords(runDir)).filter(
		(record) => record.status === "grading",
	);
	console.info(`Collecting ${pending.length} grading run(s) in ${runDir}.`);
	await Promise.all(
		pending.map(async (record) => {
			await finishGrading(record, invocationDeadline - 15_000);
			await saveRecord(runDir, record);
			console.info(
				`${record.task}.${record.attempt}: ${record.status === "grading" ? "still grading" : record.passed ? "PASS" : "fail"} reward=${record.reward}`,
			);
		}),
	);
	if (pending.length) printTable(pending);
	process.exit(0);
}

// ----------------------------------------------------------------------------
// Running tasks.

const mode = flags.mode as "agent" | "oracle" | "nop";
if (!["agent", "oracle", "nop"].includes(mode))
	throw new Error("--mode accepts agent, oracle or nop.");
if (!flags.live)
	throw new Error(
		"Refusing to run: pass --live (dev VMs, and the Codex subscription in agent mode).",
	);
const variant = harnessVariantFromFlags(flags.variant);
const tasks = selectedTasks();
const requestedAgentSeconds = Math.round(Number(flags["agent-minutes"]) * 60);
if (!(requestedAgentSeconds >= 60))
	throw new Error("--agent-minutes must be at least 1.");
const route = hardSetRoute(flags.model as string);
// Gemini's free tier is per project and model (5 requests/min measured on
// 2026-10-18), so Gemini runs share the `gemini` slots (default 1).
const routeSlots =
	route.kind === "google" ? SLOT_LIMITS.gemini : SLOT_LIMITS.codex;
const concurrency = Math.max(
	1,
	Math.min(routeSlots, Number(flags.concurrency) || tasks.length),
);
if (flags.reasoning && !/^[a-z]+$/.test(flags.reasoning))
	throw new Error("--reasoning expects an effort name such as medium or high.");
const model = route.modelId;
await assertDevelopmentDatabase();

// Same development-edge wiring as the smoke suite (scripts/smoke/builder-harness.ts).
process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;

let stopping = false;
let usageLimitHit: string | null = null;
const live = new Set<() => Promise<void>>();
onEvalStop(() => {
	stopping = true;
});
// The invocation never outlives its ceiling: past it, live turns are
// cancelled and cleaned up; a minute later the process exits regardless.
const watchdog = setTimeout(
	() => {
		stopping = true;
		console.warn("Invocation ceiling reached; cancelling live runs.");
		void Promise.allSettled([...live].map((cancel) => cancel())).finally(() =>
			setTimeout(() => process.exit(3), 60_000).unref(),
		);
	},
	invocationDeadline - Date.now() + 20_000,
);
watchdog.unref();

async function preflightExecutor() {
	const url = `${DEVELOPMENT_EDGE_ORIGIN}/start`;
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

/** The subscription's 5-hour and weekly usage, read only (no inference). */
async function codexUsage(ownerId: string) {
	try {
		const response = await subscriptionFetch(ownerId, "wham/usage");
		if (!response.ok) return `usage unavailable (${response.status})`;
		const body = (await response.json()) as {
			rate_limit?: {
				limit_reached?: boolean;
				primary_window?: { used_percent?: number };
				secondary_window?: { used_percent?: number };
			};
		};
		const limit = body.rate_limit;
		return `5h ${limit?.primary_window?.used_percent ?? "?"}%, week ${limit?.secondary_window?.used_percent ?? "?"}%${limit?.limit_reached ? " (LIMIT REACHED)" : ""}`;
	} catch (error) {
		return `usage unavailable (${safe(error)})`;
	}
}

const ENVIRONMENT_NOTE = (workdir: string) =>
	`\n\n(Environment: your shell commands run inside the task's container, starting in ${workdir}. File tools reach the task's working directory directly; use the shell for files elsewhere.)`;
const PROMPT_SUFFIX =
	"\n\nWork directly in this environment: no plan proposal, child tasks, commits, pull requests or publishing. Stop when the task is done and checked.";

/** A VM from the workspace image, resized; Freestyle caps a VM at 8 vCPUs. */
async function createVm(
	slug: string,
	purpose: string,
	cpus: number,
	memoryMb: number,
	lifetimeSec: number,
	onCreated: (vmId: string) => void,
) {
	const created = await client.vms.create({
		slug,
		snapshotId: await workspaceBootSnapshotId(),
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: lifetimeSec + 300,
		maxRunTotalSeconds: lifetimeSec,
		// Tests run for minutes with nobody polling (a grader outlives its
		// invocation); an idle stop would kill them, so idling never stops it.
		idleTimeoutSeconds: lifetimeSec,
		automaticRestart: false,
		metadata: { purpose },
	} as never);
	onCreated(created.vmId);
	const data = await waitUntilVmRunning(created.vm, "Hard set");
	// At least the task's own size, and 4 vCPUs so builds and tests fit the
	// invocation; memory for the workspace itself; disk for the images.
	const target = {
		cpu: Math.min(8, Math.max(4, cpus)),
		memory: Math.min(16384, Math.max(4096, memoryMb + 2048)),
		storage: Math.max(data.resources.storage, 32768),
	};
	await created.vm.resize(target);
	// Resized CPUs come online a few seconds after the resize.
	for (let attempt = 0; attempt < 15; attempt++) {
		const online = await machines
			.exec(WorkspaceId(created.vmId), "nproc", 15_000)
			.catch(() => null);
		if (Number(online?.stdout.trim()) >= target.cpu) break;
		await delay(2000);
	}
	await execOk(
		created.vmId,
		"sudo mkdir -p /tb && sudo chown ubuntu:ubuntu /tb",
		30_000,
	);
	return `${target.cpu} cpu / ${target.memory} MB / ${target.storage} MB`;
}

async function runTask(
	task: HardSetTask,
	environment: TaskEnvironment,
	attempt: string,
): Promise<HardSetRecord> {
	const record: HardSetRecord = {
		...emptyRecord(route.recordModel, task.id),
		run: flags.run as string,
		attempt,
		category: task.category,
		mode,
		variant: harnessVariantLabel(variant),
		reasoning: flags.reasoning ?? null,
		startedAt: new Date().toISOString(),
		reward: null,
		passed: false,
		status: "error",
		setupSec: 0,
		agentSec: 0,
		agentBudgetSec: 0,
		agentRequestedSec: 0,
		stageSec: 0,
		gradeSec: 0,
		testsExit: null,
		testsTail: "",
		gradeError: null,
		usageLimit: null,
		vmResources: null,
		graderVmId: null,
		gradeStartedAt: null,
		gradeTimeoutSec: null,
	};
	const started = Date.now();
	const agentSeconds = Math.min(
		requestedAgentSeconds,
		(task.maxAgentMinutes ?? Number.POSITIVE_INFINITY) * 60,
	);
	if (mode === "agent") record.agentRequestedSec = agentSeconds;
	if (stopping) {
		record.state = "skipped";
		record.errors.push(usageLimitHit ?? "Run stopped before this task.");
		await saveRecord(runDir, record);
		return record;
	}
	let user: EvalUser | undefined;
	let sessionId: string | undefined;
	let agentVm: string | undefined;
	let graderVm: string | undefined;
	let keepGrader = false;
	const cancel = async () => {
		if (user && sessionId)
			await cancelServerTurn(user.userId, sessionId).catch(() => {});
	};
	live.add(cancel);
	try {
		user = await createEvalUser({
			label: `hard-set ${task.id} ${harnessVariantLabel(variant)}`,
			variant,
			...(google ? { google } : {}),
		});
		const listedModelId =
			route.kind === "google"
				? modelRouteId(user.googleConnectionId as string, model)
				: model;
		const session = await insertAgentSession({
			userId: user.userId,
			projectId: user.project.projectId,
			workspaceId: user.project.workspaceId,
			harness: route.kind === "google" ? "api" : "codex",
			title: `Hard set ${task.id}`,
			listedModelId,
		});
		sessionId = session.id;
		// The grader VM boots and pulls the verifier image while the agent works.
		const grader = createVm(
			`ytimesy-hardset-grader-${randomUUID().slice(0, 12)}`,
			"ytimesy-hard-set-grader",
			environment.verifierCpus,
			environment.verifierMemoryMb,
			GRADER_LIFETIME_SEC,
			(vmId) => {
				graderVm = vmId;
			},
		).then(async () => {
			await startDetached(
				graderVm as string,
				graderPullScript(environment),
				"pull",
			);
			return graderVm as string;
		});
		grader.catch(() => {});
		const owner = user;
		// Usage admission resolves the VM owner from this session-derived slug.
		record.vmResources = await createVm(
			`ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
			"ytimesy-hard-set",
			environment.cpus,
			environment.memoryMb,
			Math.ceil((invocationDeadline - Date.now()) / 1000) + 120,
			(vmId) => {
				agentVm = vmId;
				void owner.trackVm(vmId);
			},
		);
		const vm = agentVm as string;
		await saveAgentSessionProviderRef(session.id, vm);
		for (const [path, content] of Object.entries(
			setupFiles(environment, user.project.dirName),
		))
			await machines.writeTextFile(WorkspaceId(vm), path, content);
		if (mode === "oracle")
			await uploadDirectory(
				vm,
				join(environment.dir, "solution"),
				"/tb/solution",
			);
		const setup = await runDetached(
			vm,
			"exec bash /tb/setup.sh\n",
			"setup-run",
			Math.min(
				300,
				Math.floor(
					(invocationDeadline - Date.now()) / 1000 - AFTER_AGENT_RESERVE_SEC,
				),
			),
		);
		record.setupSec = seconds(started);
		console.info(
			`${task.id}: setup ${setup.exit === 0 ? "ok" : `FAILED (${setup.exit})`} in ${record.setupSec}s`,
		);
		if (setup.exit !== 0)
			throw new Error(`Environment setup failed: ${setup.log.slice(-1200)}`);
		const workdir = (await execOk(vm, "cat /tb/workdir", 15_000)).trim();
		const agentStarted = Date.now();
		const agentDeadline = Math.min(
			agentStarted + agentSeconds * 1000,
			invocationDeadline - AFTER_AGENT_RESERVE_SEC * 1000,
		);
		record.agentBudgetSec = Math.max(
			0,
			Math.round((agentDeadline - agentStarted) / 1000),
		);
		if (mode === "oracle") {
			const oracle = await runDetached(
				vm,
				oracleScript(
					environment,
					Math.max(30, (agentDeadline - Date.now()) / 1000),
				),
				"oracle",
				Math.max(60, (agentDeadline - Date.now()) / 1000 + 30),
			);
			record.state = /ORACLE_EXIT=0/.test(oracle.log)
				? "completed"
				: "oracle-failed";
			if (record.state !== "completed")
				record.errors.push(safe(oracle.log.slice(-600)));
		} else if (mode === "agent") {
			if (record.agentBudgetSec < 60)
				throw new Error("Setup left no time for the agent.");
			await database().query(
				"update agent_session set status='ready' where id=$1",
				[session.id],
			);
			const text = `${environment.instruction}${ENVIRONMENT_NOTE(workdir)}${PROMPT_SUFFIX}`;
			const scope = {
				userId: owner.userId,
				projectId: owner.project.projectId,
				sessionId: session.id,
			};
			await withSlot(
				route.kind === "google" ? "gemini" : "codex",
				routeSlots,
				async () => {
					await withBackgroundJobDispatcher(
						async () => {},
						() =>
							route.kind === "google"
								? sendApiWorkspaceTask(scope, {
										modelId: listedModelId,
										text,
									})
								: sendSubscriptionTask(scope, {
										modelId: model,
										text,
										variant: flags.reasoning,
									}),
					);
					let admitted = false;
					while (
						!admitted &&
						Date.now() < agentStarted + 120_000 &&
						!stopping
					) {
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
					let cancelSent = false;
					while (true) {
						const state = await turnState(session.id);
						const items = sessionItemsFromUnknown(state?.items);
						measureRun(record, items, state?.messages, () => 0);
						record.state = state?.state ?? "missing";
						const quota = quotaStop(
							route.kind,
							JSON.stringify(items.filter((item) => item.kind === "error")),
						);
						if (quota) {
							record.usageLimit = quota;
							usageLimitHit = quota;
							stopping = true;
						}
						if (state && !["queued", "running"].includes(state.state)) break;
						const reason =
							Date.now() > agentDeadline
								? `agent time limit (${record.agentBudgetSec}s)`
								: stopping
									? "run stopped"
									: null;
						if (reason && !cancelSent) {
							cancelSent = true;
							record.errors.push(`Cancelled: ${reason}.`);
							await cancelServerTurn(owner.userId, session.id);
						}
						if (Date.now() > agentDeadline + 45_000) {
							record.state = "unsettled";
							break;
						}
						await delay(3000);
					}
					if (flags.transcripts) {
						const state = await turnState(session.id);
						await writeFile(
							join(runDir, `${task.id}.${attempt}.transcript.json`),
							JSON.stringify(
								{ items: state?.items, messages: state?.messages },
								null,
								1,
							),
						).catch((error) =>
							console.warn("Transcript was not written:", safe(error)),
						);
					}
				},
				() => stopping,
			);
			record.completed = record.state === "completed";
		} else {
			record.state = "nop";
		}
		record.agentSec = seconds(agentStarted);
		if (record.usageLimit) throw new Error(record.usageLimit);
		// Stage: collect and copy the artifacts out of the task environment.
		const stageStarted = Date.now();
		await cancel();
		const staged = await runDetached(
			vm,
			stageScript(environment),
			"stage",
			120,
		);
		if (staged.exit !== 0)
			throw new Error(`Staging failed: ${staged.log.slice(-600)}`);
		const artifacts = await client.vms.ref(vm).fs.readFile("/tb/artifacts.tgz");
		record.stageSec = seconds(stageStarted);
		// Grade on the grader VM: the tests never reach the agent's VM.
		const graderId = await grader;
		await client.vms.ref(graderId).fs.writeFile("/tb/artifacts.tgz", artifacts);
		const hasTests = await machines.exec(
			WorkspaceId(graderId),
			`for _ in $(seq 240); do [ -f /tb/pull.exit ] && break; sleep 1; done; sudo docker run --rm --entrypoint test ${sh(environment.verifierImage)} -f /tests/test.sh`,
			280_000,
		);
		if (hasTests.exitCode !== 0)
			await uploadDirectory(
				graderId,
				join(environment.dir, "tests"),
				"/tb/tests",
			);
		record.graderVmId = graderId;
		record.gradeStartedAt = new Date().toISOString();
		record.gradeTimeoutSec = environment.verifierTimeoutSec;
		await startDetached(
			graderId,
			verifyScript(environment, environment.verifierTimeoutSec),
			"verify",
		);
		record.status = "grading";
		keepGrader = true;
		await saveRecord(runDir, record);
	} catch (error) {
		record.errors.push(safe(error));
		record.status = "error";
	} finally {
		live.delete(cancel);
		if (user && sessionId)
			await cancelServerTurn(user.userId, sessionId).catch(() => {});
		if (agentVm) await client.vms.delete(agentVm).catch(() => {});
		if (user && sessionId)
			await deleteAgentSessionForOwner(user.userId, sessionId).catch(() => {});
		if (user) {
			const leaked = await user.release();
			if (leaked.length)
				record.errors.push(`Cleanup left: ${leaked.join(", ")}`);
		}
		if (!keepGrader && graderVm)
			await client.vms.delete(graderVm).catch(() => {});
		record.elapsedMs = record.agentSec * 1000;
	}
	// Wait for the tests while the invocation has time; --collect finishes the rest.
	if (record.status === "grading")
		await finishGrading(record, invocationDeadline - 15_000);
	await saveRecord(runDir, record);
	console.info(
		`${task.id}: ${record.status === "grading" ? "grading (collect later)" : record.passed ? "PASS" : "fail"} reward=${record.reward} state=${record.state} agent=${record.agentSec}s/${record.agentBudgetSec}s total=${seconds(started)}s${record.errors.length ? ` errors=${record.errors.join(" | ").slice(0, 300)}` : ""}`,
	);
	return record;
}

const environments = new Map<string, TaskEnvironment>();
for (const task of tasks) {
	const environment = await loadTaskEnvironment(
		flags.dataset as string,
		task.id,
	);
	if (environment.gpus > 0) throw new Error(`${task.id} needs a GPU.`);
	if (environment.mcpServers > 0)
		throw new Error(`${task.id} needs task MCP servers; unsupported.`);
	environments.set(task.id, environment);
}
if (mode === "agent") await preflightExecutor();
// A Gemini run: the key's catalog entry for the model, and one probe request
// so a spent quota stops the run before any VM starts.
const google =
	mode === "agent" && route.kind === "google"
		? await (async () => {
				const apiKey = await readGeminiKey(flags["google-key-file"]);
				const models = await geminiConnectionModels(apiKey, model);
				const quota = await probeGeminiQuota(apiKey, model);
				if (quota.state === "limited") {
					console.log(
						`GEMINI_QUOTA ${JSON.stringify({ daily: quota.daily, retryAfterSec: quota.retryAfterSec, quotaIds: quota.quotaIds })}`,
					);
					throw new Error(
						`Gemini quota reached (${quota.quotaIds.join(", ") || "429"}${quota.retryAfterSec ? `, retry in ${quota.retryAfterSec}s` : ""}); not starting.`,
					);
				}
				if (quota.state === "error")
					throw new Error(`Gemini probe failed (HTTP ${quota.status}).`);
				return { apiKey, models };
			})()
		: null;
const ownerId =
	mode === "agent" && route.kind === "codex" ? await subscriptionOwner() : null;
const usageBefore = ownerId ? await codexUsage(ownerId) : null;
console.info(
	`Hard set run ${flags.run}: ${tasks.length} task(s), mode ${mode}, variant ${harnessVariantLabel(variant)}, model ${model}${flags.reasoning ? ` (${flags.reasoning})` : ""}, agent ${requestedAgentSeconds}s (less for large images), ceiling ${maxMinutes} min, concurrency ${concurrency}.${usageBefore ? ` Codex usage before: ${usageBefore}.` : ""}`,
);
if (usageBefore?.includes("LIMIT REACHED"))
	throw new Error("Codex usage limit already reached; not starting.");

const existing = await readRecords(runDir);
const attemptFor = (id: string) => {
	const used = existing.filter((record) => record.task === id).length;
	existing.push({ task: id } as HardSetRecord);
	return String(used + 1);
};
const records: HardSetRecord[] = [];
const queue = tasks.map((task) => ({ task, attempt: attemptFor(task.id) }));
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		while (queue.length) {
			const next = queue.shift() as (typeof queue)[number];
			records.push(
				await runTask(
					next.task,
					environments.get(next.task.id) as TaskEnvironment,
					next.attempt,
				),
			);
		}
	}),
);
clearTimeout(watchdog);
const usageAfter = ownerId ? await codexUsage(ownerId) : null;
await closeDatabase();
const order = new Map(tasks.map((task, index) => [task.id, index]));
records.sort((a, b) => (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0));
printTable(records);
const scored = records.filter(isScored);
const grading = records.filter((record) => record.status === "grading");
console.log(
	`\n${scored.filter((record) => record.passed).length}/${scored.length} scored runs passed; ${grading.length} still grading${grading.length ? ` (then: --collect --run ${flags.run})` : ""}. Wall ${seconds(invocationStart)}s.${usageAfter ? ` Codex usage after: ${usageAfter}.` : ""}${usageLimitHit ? ` STOPPED on a usage limit: ${usageLimitHit}` : ""}\nRecords: ${runDir}`,
);
const cost = costSummary(scored.filter((record) => record.mode === "agent"));
if (cost) console.log(cost);
for (const record of records.filter(
	(record) => record.errors.length || record.gradeError,
))
	console.log(
		`- ${record.task}: ${[...record.errors, record.gradeError].filter(Boolean).join(" | ").slice(0, 500)}`,
	);
process.exit(0);
