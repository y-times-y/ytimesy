// Long-history memory eval: our memory (defaults: observer writer, rules
// wording) against Supermemory's Claude Code plugin on a seeded history of
// ~150 lines with superseded decisions, expired entries, near-duplicates and
// distractors. Development only.
//
//   node --import tsx scripts/memory-long-history-eval.ts --dry-run
//       Offline: every probe verifier fails the untouched fixture and the
//       stale answer and passes the current one; no prompt or fixture leaks
//       its fact; the seed parses as intended.
//   node --env-file=.env --import tsx scripts/memory-long-history-eval.ts --live --arm ours
//   node --env-file=.env --import tsx scripts/memory-long-history-eval.ts --live --arm supermemory-instant
//   node --env-file=.env --import tsx scripts/memory-long-history-eval.ts --live --arm supermemory-dynamic
//       One arm per process (one eval user, one memory): seed, the update
//       chats in order, the probe chats, then the freshness pairs. Writes
//       /tmp/memory-long-history-<arm>-<time>.json.
//   node --import tsx scripts/memory-long-history-eval.ts --report a.json,b.json,c.json
//       Tables across arms.
//
// Arms:
//   ours                 memory mode full, the default harness variant. The
//                        seed is pushed to the user's memory repo through the
//                        Worker-side Git writer (eval-only setup). After each
//                        update chat: the save hook (automatic), then one dream
//                        (dreamNow: the idle period between sessions).
//   supermemory-instant  our memory off; the plugin replayed (memory-eval/
//   supermemory-dynamic  supermemory.ts): every chat gets session-start's
//                        profile and the prompt recall as extra text parts;
//                        each update chat is captured as one document and
//                        processed before the next chat. instant sends
//                        dreaming: "instant"; dynamic sends nothing (the
//                        plugin's default). The seed is one captured chat per
//                        month, oldest first, each processed before the next.
//                        Probe chats are not captured (they state no facts).
// Freshness: the probe's VM and fixture are ready before the update chat
// ends; the probe is sent as soon as the update settles (ours: no dream; the
// save hook races the probe. Supermemory: the capture is posted, then the
// probe's recall runs right away, and the document's status is polled until
// processed).
import { execFile } from "node:child_process";
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
import { dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
	attachedMemory,
	memoryLines,
	memoryToday,
} from "../src/domain/memory-repo";
import type { SessionItem } from "../src/domain/session-item";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";
import {
	EXPIRED_LEAK_CHECK,
	FRESHNESS,
	HISTORY,
	historyStats,
	type LongChat,
	PROBES,
	type Probe,
	seedFiles,
	supermemorySeedDocuments,
	UPDATES,
} from "./memory-eval/long-history";
import {
	captureText,
	type ProfileResponse,
	recallContext,
	recalledResults,
	recallQuery,
	sessionStartContext,
	supermemoryApiKey,
	supermemoryClient,
} from "./memory-eval/supermemory";
import { chatMemoryActivity } from "./memory-eval/writes";
import {
	assertDevelopmentDatabase,
	createEvalUser,
	type EvalUser,
	MEMORY_NAMESPACE,
	onEvalStop,
	SLOT_LIMITS,
	withSlot,
} from "./smoke/eval-user";

const runCommand = promisify(execFile);

const { values: flags } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		live: { type: "boolean", default: false },
		report: { type: "string" },
		/** Offline: the read hook's ranking for each probe on an ours run's snapshot. */
		"recall-check": { type: "string" },
		/** Offline: the read hook's wall time on the seeded ~150 lines, cold and warm. */
		"hook-latency": { type: "boolean", default: false },
		arm: { type: "string" },
		model: { type: "string", default: "gpt-6.1-sol" },
		effort: { type: "string", default: "medium" },
		"turn-timeout": { type: "string", default: "420" },
		"dream-timeout": { type: "string", default: "600" },
		/** Seconds to wait for Supermemory to process one document. */
		"sm-wait": { type: "string", default: "900" },
		"probe-concurrency": { type: "string", default: "3" },
		/** Subsets, comma-separated ids; "none" skips the stage. */
		updates: { type: "string" },
		probes: { type: "string" },
		freshness: { type: "string" },
		out: { type: "string" },
	},
});

const ARMS = ["ours", "supermemory-instant", "supermemory-dynamic"] as const;
type Arm = (typeof ARMS)[number];

const PROMPT_SUFFIX =
	"\n\nWork directly in this repository: no plan proposal, child tasks, pull requests or publishing, and no commits to this repository. Stop when the change is done and checked.";

const USAGE_LIMIT = /usage limit is used up|usage_limit_reached/i;

const fixtureRepoScript = (dir: string) =>
	`cd '${dir}' && git init -q && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -qm fixture && git update-ref refs/ytimesy/base HEAD`;

const shellCommand = (script: string) =>
	`bash -c '${script.replaceAll("'", "'\\''")}'`;

const errorText = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? "").length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  "),
		)
		.join("\n");
}

function subset<T extends { id: string }>(all: readonly T[], spec?: string) {
	if (!spec) return [...all];
	if (spec === "none") return [];
	return spec.split(",").map((id) => {
		const found = all.find((row) => row.id === id.trim());
		if (!found)
			throw new Error(
				`Unknown id ${id}; choose from ${all.map((row) => row.id).join(", ")}.`,
			);
		return found;
	});
}

// ---------------------------------------------------------------------------
// --dry-run

async function writeFiles(dir: string, files: Record<string, string | null>) {
	for (const [path, content] of Object.entries(files)) {
		const target = join(dir, path);
		if (content === null) {
			await rm(target, { force: true });
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function verifyLocally(
	probe: Probe,
	solution: Record<string, string | null>,
	script = probe.verify,
) {
	const dir = await mkdtemp(join(tmpdir(), `long-history-${probe.id}-`));
	try {
		await writeFiles(dir, probe.files);
		await runCommand("bash", ["-c", fixtureRepoScript(dir)]);
		await writeFiles(dir, solution);
		try {
			await runCommand("bash", ["-c", shellCommand(script)], {
				cwd: dir,
				timeout: 30_000,
			});
			return true;
		} catch {
			return false;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function dryRun() {
	const probes = [...PROBES, ...FRESHNESS.map((pair) => pair.probe)];
	const rows = [
		[
			"probe",
			"type",
			"untouched",
			"current",
			"stale",
			"no leak",
			"expired check",
		],
	];
	let ok = true;
	for (const probe of probes) {
		const untouched = await verifyLocally(probe, {});
		const follows = await verifyLocally(probe, probe.solutions.follows);
		const breaks = await verifyLocally(probe, probe.solutions.breaks);
		const leaked = [probe.prompt, ...Object.values(probe.files)].some((text) =>
			probe.leaks.test(text),
		);
		// The cross-cutting expired check: clean on the current answer, caught
		// when the expired banner is added to it.
		const cleanOk = await verifyLocally(
			probe,
			probe.solutions.follows,
			EXPIRED_LEAK_CHECK,
		);
		const firstPath = Object.keys(probe.solutions.follows)[0];
		const banner = await verifyLocally(
			probe,
			{
				...probe.solutions.follows,
				[firstPath]: `# FREEZE: release 4.2\n${probe.solutions.follows[firstPath] ?? ""}`,
			},
			EXPIRED_LEAK_CHECK,
		);
		const good =
			!untouched && follows && !breaks && !leaked && cleanOk && !banner;
		ok &&= good;
		rows.push([
			probe.id,
			probe.type,
			untouched ? "PASSES (bad)" : "fails",
			follows ? "passes" : "FAILS (bad)",
			breaks ? "PASSES (bad)" : "fails",
			leaked ? "LEAKS" : "ok",
			cleanOk && !banner ? "ok" : "BROKEN",
		]);
	}
	console.log(table(rows));
	// Update chats must not be probes' fixtures in disguise: each states a change.
	const stats = historyStats();
	const files = seedFiles();
	const parsed = memoryLines(files).filter(
		(entry) => !/^\[\[.*\]\]$/.test(entry.text),
	);
	const today = memoryToday();
	const expired = parsed.filter(
		(entry) => entry.meta.expires && entry.meta.expires < today,
	);
	const docs = supermemorySeedDocuments();
	const checks: Record<string, boolean> = {
		"~150 lines": stats.lines >= 140 && stats.lines <= 170,
		"6+ superseded": (stats.roles.superseded ?? 0) >= 6,
		"4+ expired": (stats.roles.expired ?? 0) >= 4,
		"near-duplicates": (stats.roles["near-duplicate"] ?? 0) >= 3,
		"seed parses line for line": parsed.length === HISTORY.length,
		"expired entries are past": expired.length === (stats.roles.expired ?? 0),
		"supermemory docs cover every line": docs.every((doc) =>
			doc.content.startsWith("<|turn_start|>"),
		)
			? HISTORY.every((entry) =>
					docs.some((doc) => doc.content.includes(entry.text)),
				)
			: false,
		"5-8 updates": UPDATES.length >= 5 && UPDATES.length <= 8,
		"8-12 probes": PROBES.length >= 8 && PROBES.length <= 12,
	};
	console.log(
		`\nSeed: ${stats.lines} lines in ${stats.files} files (${Object.entries(
			stats.roles,
		)
			.map(([role, count]) => `${role} ${count}`)
			.join(
				", ",
			)}); MEMORY.md ${files["MEMORY.md"].length} chars; ${docs.length} Supermemory documents (one per month).`,
	);
	const failed = Object.entries(checks).flatMap(([name, pass]) =>
		pass ? [] : [name],
	);
	if (failed.length) console.log(`Seed checks failed: ${failed.join(", ")}`);
	if (!ok || failed.length)
		throw new Error("A probe, verifier or seed is invalid.");
	console.log("\nDry run passed.");
}

// ---------------------------------------------------------------------------
// --live: environment and chats (as in memory-two-chat-eval.ts, with the
// chat split into prepare and send so a freshness probe starts at once).

async function liveEnvironment() {
	await assertDevelopmentDatabase();
	process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
	process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
	process.env.YTIMESY_MODEL_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_BACKGROUND_WORKFLOW_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_URL = DEVELOPMENT_EDGE_ORIGIN;
	process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	).secret;
	const apiKey = process.env.FREESTYLE_API_KEY;
	if (!apiKey) throw new Error("Missing Freestyle API key.");
	const { Freestyle } = await import("freestyle");
	const { WorkspaceId } = await import("../src/domain/ids");
	const { sessionItemsFromUnknown } = await import(
		"../src/domain/session-item"
	);
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const sessions = await import("../src/server/adapters/agent-sessions");
	const { claimApiTurn } = await import("../src/server/adapters/api-turns");
	const { dispatchBackgroundJob, withBackgroundJobDispatcher } = await import(
		"../src/server/adapters/background-job-dispatch"
	);
	const { closeDatabase, database } = await import(
		"../src/server/adapters/database"
	);
	const { workspaceBootSnapshotId } = await import(
		"../src/server/records/tools-snapshot-store"
	);
	const bootSnapshotId = await workspaceBootSnapshotId();
	const { GUEST_INTERNET_FIREWALL } = await import(
		"../src/server/adapters/freestyle/proof-vm"
	);
	const { waitUntilVmRunning } = await import(
		"../src/server/adapters/freestyle/wait-until-running"
	);
	const { createFreestyleWorkspaceMachines } = await import(
		"../src/server/adapters/freestyle/workspace-machines"
	);
	const { dispatchModelWorkflow, modelWorkflowSigningSecret } = await import(
		"../src/server/adapters/model-workflow-dispatch"
	);
	const { cancelServerTurn } = await import(
		"../src/server/services/cancel-server-turn"
	);
	const { sendSubscriptionTask } = await import(
		"../src/server/services/codex-subscription-session"
	);
	const { turnState } = await import("./smoke/builder-harness");
	return {
		client: new Freestyle({ apiKey }),
		machines: createFreestyleWorkspaceMachines(apiKey),
		db: database(),
		closeDatabase,
		bootSnapshotId,
		WorkspaceId,
		sessionItemsFromUnknown,
		signDeliveryRequest,
		sessions,
		claimApiTurn,
		dispatchBackgroundJob,
		withBackgroundJobDispatcher,
		GUEST_INTERNET_FIREWALL,
		waitUntilVmRunning,
		dispatchModelWorkflow,
		modelWorkflowSigningSecret,
		cancelServerTurn,
		sendSubscriptionTask,
		turnState,
	};
}

type LiveEnvironment = Awaited<ReturnType<typeof liveEnvironment>>;
type Sm = ReturnType<typeof supermemoryClient>;

type SmOp = { op: string; ms: number; ok: boolean };

type Run = {
	arm: Arm;
	env: LiveEnvironment;
	user: EvalUser;
	model: string;
	effort: string;
	turnTimeoutMs: number;
	dreamTimeoutMs: number;
	smWaitMs: number;
	sm: Sm | null;
	smOps: SmOp[];
	containerTag: string | null;
	repo: string | null;
	liveVms: Set<string>;
	stopped: () => boolean;
	/** Set once a turn reports the plan's Codex usage limit; no new chats. */
	usageLimit: string | null;
};

async function openExecutorGate(env: LiveEnvironment) {
	const url = `${DEVELOPMENT_EDGE_ORIGIN}/start`;
	const body = JSON.stringify({ turnId: randomUUID(), leaseId: randomUUID() });
	for (let attempt = 0; attempt < 30; attempt++) {
		const response = await fetch(url, {
			method: "POST",
			body,
			headers: await env.signDeliveryRequest(
				env.modelWorkflowSigningSecret(),
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

type Prepared = {
	input: LongChat;
	sessionId: string;
	vmId: string;
	workspace: ReturnType<LiveEnvironment["WorkspaceId"]>;
	dir: string;
};

export type ChatResult = {
	id: string;
	sessionId: string | null;
	state: string;
	errors: string[];
	sentAt: number | null;
	settledAt: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	toolCalls: number;
	/** Builder tool calls that read or wrote ~/memory. */
	memoryToolCalls: number;
	/** The memory text the model got: our <memory> parts or the plugin's parts. */
	injected: string;
	commands: string[];
	finalAnswer: string;
	passed: boolean | null;
	verifierOutput: string;
	expiredLeak: string | null;
	/** Ours: the read hook's outcome and wall time, as recorded on the request. */
	hook?: { outcome: string; ms: number; error?: string };
	/** Supermemory: the plugin's recall for this prompt. */
	smRecall?: {
		profileItems: number;
		recalled: number;
		hits: { similarity: number | null; text: string }[];
	};
};

/** A session on a fresh VM with the fixture files, ready for one prompt. */
async function prepareChat(
	run: Run,
	input: LongChat,
	idleSeconds = 300,
): Promise<Prepared> {
	const { env, user } = run;
	const session = await env.sessions.insertAgentSession({
		userId: user.userId,
		projectId: user.project.projectId,
		workspaceId: user.project.workspaceId,
		harness: "codex",
		title: `Long-history eval ${input.id}`,
		listedModelId: run.model,
	});
	const turnSeconds = Math.ceil(run.turnTimeoutMs / 1000);
	const created = await env.client.vms.create({
		slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
		snapshotId: env.bootSnapshotId,
		firewall: env.GUEST_INTERNET_FIREWALL,
		ttlSeconds: turnSeconds + idleSeconds + 900,
		maxRunTotalSeconds: turnSeconds + idleSeconds + 600,
		idleTimeoutSeconds: idleSeconds,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-memory-eval" },
	});
	const vmId = created.vmId;
	run.liveVms.add(vmId);
	await user.trackVm(vmId);
	await env.sessions.saveAgentSessionProviderRef(session.id, vmId);
	await env.waitUntilVmRunning(created.vm, "Long-history eval");
	const workspace = env.WorkspaceId(vmId);
	const home = (
		await env.machines.exec(workspace, 'printf %s "$HOME"', 15_000)
	).stdout.trim();
	if (!home.startsWith("/")) throw new Error("VM home is unavailable.");
	const dir = `${home}/${user.project.dirName}`;
	const directories = new Set(
		Object.keys(input.files)
			.filter((path) => path.includes("/"))
			.map((path) => `${dir}/${path.slice(0, path.lastIndexOf("/"))}`),
	);
	await env.machines.exec(
		workspace,
		`mkdir -p ${[dir, ...directories].map((path) => `'${path}'`).join(" ")}`,
		15_000,
	);
	for (const [path, content] of Object.entries(input.files))
		await env.machines.writeTextFile(workspace, `${dir}/${path}`, content);
	const setup = await env.machines.exec(
		workspace,
		`${fixtureRepoScript(dir)} && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
		20_000,
	);
	if (setup.exitCode) throw new Error("Fixture repository setup failed.");
	await env.db.query("update agent_session set status='ready' where id=$1", [
		session.id,
	]);
	return { input, sessionId: session.id, vmId, workspace, dir };
}

async function releasePrepared(run: Run, prepared: Prepared | null) {
	if (!prepared) return;
	await run.env
		.cancelServerTurn(run.user.userId, prepared.sessionId)
		.catch(() => {});
	await run.env.client.vms
		.delete(prepared.vmId)
		.then(() => run.liveVms.delete(prepared.vmId))
		.catch(() => {});
}

function emptyResult(id: string, sessionId: string | null): ChatResult {
	return {
		id,
		sessionId,
		state: "not-started",
		errors: [],
		sentAt: null,
		settledAt: null,
		inputTokens: null,
		outputTokens: null,
		toolCalls: 0,
		memoryToolCalls: 0,
		injected: "",
		commands: [],
		finalAnswer: "",
		passed: null,
		verifierOutput: "",
		expiredLeak: null,
	};
}

/** Sends the prompt (with the plugin's parts, if any), follows it, verifies. */
async function sendPrepared(
	run: Run,
	prepared: Prepared,
	options: { extraParts?: readonly string[]; verify?: string } = {},
): Promise<{ result: ChatResult; items: SessionItem[] }> {
	const { env, user } = run;
	const result = emptyResult(prepared.input.id, prepared.sessionId);
	let items: SessionItem[] = [];
	try {
		result.sentAt = Date.now();
		await env.withBackgroundJobDispatcher(
			async () => {},
			() =>
				env.sendSubscriptionTask(
					{
						userId: user.userId,
						projectId: user.project.projectId,
						sessionId: prepared.sessionId,
					},
					{
						modelId: run.model,
						text: `${prepared.input.prompt}${PROMPT_SUFFIX}`,
						variant: run.effort,
					},
				),
		);
		if (options.extraParts?.length)
			await attachExtraParts(env, prepared.sessionId, options.extraParts);
		await admitTurn(env, prepared.sessionId, Date.now());
		items = await followTurn(run, prepared.sessionId, result);
		result.settledAt = Date.now();
		const activity = chatMemoryActivity(items);
		result.toolCalls = activity.toolCalls;
		result.memoryToolCalls = activity.memoryToolCalls;
		result.commands = items.flatMap((item) =>
			item.kind === "commandExecution"
				? [item.command.slice(0, 300)]
				: item.kind === "dynamicToolCall"
					? [`${item.tool}: ${(item.input ?? "").slice(0, 300)}`]
					: [],
		);
		result.finalAnswer =
			[...items]
				.reverse()
				.find((item) => item.kind === "agentMessage")
				?.text.slice(0, 1500) ?? "";
		if (options.verify) {
			const verified = await env.machines.exec(
				prepared.workspace,
				`cd '${prepared.dir}' && ${shellCommand(options.verify)}`,
				90_000,
			);
			result.passed = verified.exitCode === 0;
			result.verifierOutput = `${verified.stdout}${verified.stderr}`
				.trim()
				.slice(-500);
			const leak = await env.machines.exec(
				prepared.workspace,
				`cd '${prepared.dir}' && ${shellCommand(EXPIRED_LEAK_CHECK)}`,
				30_000,
			);
			result.expiredLeak =
				leak.exitCode === 0 ? null : `${leak.stdout}${leak.stderr}`.trim();
		}
	} catch (error) {
		result.errors.push(errorText(error));
	}
	return { result, items };
}

async function attachExtraParts(
	env: LiveEnvironment,
	sessionId: string,
	extraParts: readonly string[],
) {
	const queued = (
		await env.db.query<{
			id: string;
			messages: { role: string; content: unknown }[];
		}>(
			"select id,messages from api_turn where session_id=$1 and state='queued' order by created_at desc limit 1",
			[sessionId],
		)
	).rows[0];
	const messages = [...(queued?.messages ?? [])];
	const index = messages.map((m) => m.role).lastIndexOf("user");
	if (!queued || index < 0)
		throw new Error("No queued user message to attach context to.");
	const own = messages[index].content;
	messages[index] = {
		...messages[index],
		content: [
			...(typeof own === "string"
				? [{ type: "text", text: own }]
				: (own as unknown[])),
			...extraParts.map((text) => ({ type: "text", text })),
		],
	};
	const updated = await env.db.query(
		"update api_turn set messages=$2::jsonb,updated_at=now() where id=$1 and state='queued'",
		[queued.id, JSON.stringify(messages)],
	);
	if (updated.rowCount !== 1)
		throw new Error("The turn left the queue before context was attached.");
}

async function admitTurn(
	env: LiveEnvironment,
	sessionId: string,
	started: number,
) {
	while (Date.now() - started < 120_000) {
		const turn = await env.claimApiTurn(1, 64, "durable-object", sessionId);
		if (turn?.lease_id) {
			await env.dispatchModelWorkflow(turn);
			return;
		}
		if ((await env.turnState(sessionId))?.state !== "queued") return;
		await delay(2000);
	}
	throw new Error("Turn was not admitted within two minutes.");
}

/** Polls until the turn settles; records usage and the memory the model got. */
async function followTurn(run: Run, sessionId: string, result: ChatResult) {
	const { env } = run;
	const started = Date.now();
	let items: SessionItem[] = [];
	let cancelled = false;
	for (;;) {
		const state = await env.turnState(sessionId);
		items = env.sessionItemsFromUnknown(state?.items);
		result.state = state?.state ?? "missing";
		const request = items.find((item) => item.kind === "userMessage");
		const usage = request?.apiUsage;
		if (request?.memory?.hook) result.hook = { ...request.memory.hook };
		if (usage) {
			result.inputTokens = usage.inputTokens;
			result.outputTokens = usage.outputTokens;
		}
		const messages = (state?.messages ?? []) as {
			role: string;
			content: unknown;
		}[];
		const ours = attachedMemory(messages);
		const theirs = JSON.stringify(messages).includes("<supermemory-")
			? messages.flatMap((message) =>
					message.role === "user" && Array.isArray(message.content)
						? (message.content as { type: string; text?: string }[]).flatMap(
								(part) =>
									part.type === "text" && part.text?.startsWith("<supermemory-")
										? [part.text]
										: [],
							)
						: [],
				)
			: [];
		if (ours.length || theirs.length)
			result.injected = [...ours, ...theirs].join("\n");
		if (state && !["queued", "running"].includes(state.state)) break;
		if (Date.now() > started + run.turnTimeoutMs && !cancelled) {
			cancelled = true;
			result.errors.push(`Cancelled: exceeded ${run.turnTimeoutMs / 1000}s.`);
			await env.cancelServerTurn(run.user.userId, sessionId);
		}
		if (Date.now() > started + run.turnTimeoutMs + 60_000) {
			result.state = "unsettled";
			break;
		}
		await delay(2000);
	}
	const failure = JSON.stringify(items.filter((item) => item.kind === "error"));
	if (USAGE_LIMIT.test(failure)) {
		run.usageLimit =
			/Your ChatGPT plan's Codex usage limit[^"]*/.exec(failure)?.[0] ??
			"Codex usage limit reached";
		result.errors.push(run.usageLimit);
	}
	return items;
}

/** The plugin's parts for one prompt: session-start's profile and the recall. */
async function supermemoryParts(run: Run, prompt: string) {
	const { sm, containerTag } = run;
	if (!sm || !containerTag) return { parts: [] as string[], recall: undefined };
	const project = run.user.project.dirName;
	const profile = await timedSm(run, "profile:start", () =>
		sm.profile(containerTag, project),
	).catch(() => null);
	const start = sessionStartContext(profile, containerTag, project);
	const query = recallQuery(`${prompt}${PROMPT_SUFFIX}`);
	let recall: string | null = null;
	let searched: ProfileResponse | null = null;
	if (query) {
		searched = await timedSm(run, "profile:recall", () =>
			sm.profile(containerTag, query),
		).catch(() => null);
		recall = recallContext(recalledResults(searched), containerTag);
	}
	return {
		parts: [start.text, ...(recall ? [recall] : [])],
		recall: {
			profileItems: start.items,
			recalled: recalledResults(searched).length,
			hits: (searched?.searchResults?.results ?? []).map((hit) => ({
				similarity: Number.isFinite(hit.similarity)
					? (hit.similarity as number)
					: null,
				text: (hit.memory ?? hit.chunk ?? hit.content ?? hit.text ?? "").slice(
					0,
					300,
				),
			})),
		},
	};
}

async function timedSm<T>(run: Run, op: string, work: () => Promise<T>) {
	const begun = Date.now();
	try {
		const value = await work();
		run.smOps.push({ op, ms: Date.now() - begun, ok: true });
		return value;
	} catch (error) {
		run.smOps.push({ op, ms: Date.now() - begun, ok: false });
		throw error;
	}
}

/** A document's status over time, until processed (done/failed) or the deadline. */
async function pollDocument(run: Run, id: string, deadlineMs: number) {
	const begun = Date.now();
	const polls: { atMs: number; status: string }[] = [];
	let last = "";
	for (;;) {
		const status = await timedSm(run, "document:status", () =>
			(run.sm as Sm).document(id),
		).then(
			(doc) =>
				`${doc.status ?? "unknown"}${doc.dreamingStatus ? `/${doc.dreamingStatus}` : ""}`,
			(error: Error) => `error:${error.message.slice(0, 60)}`,
		);
		if (status !== last) polls.push({ atMs: Date.now() - begun, status });
		last = status;
		const settled =
			/^(done|failed)/.test(status) && !status.includes("/dreaming");
		if (settled || Date.now() - begun > deadlineMs)
			return { settled, polls, ms: Date.now() - begun, status };
		await delay(3000);
	}
}

/** Posts one document as the arm's mode does (instant, or the plugin default). */
async function addSmDocument(
	run: Run,
	content: string,
	customId: string,
	metadata: Record<string, string>,
) {
	const dreaming = run.arm === "supermemory-instant" ? "instant" : undefined;
	return timedSm(run, "document:add", () =>
		(run.sm as Sm).addDocument(
			content,
			run.containerTag as string,
			customId,
			{
				project: run.user.project.dirName,
				sm_scope: "personal",
				sm_capture_mode: "automatic",
				timestamp: new Date().toISOString(),
				...metadata,
			},
			dreaming,
		),
	);
}

/**
 * One chat end to end, retried once on a failed turn (a provider hiccup
 * would otherwise drop an update or a probe); never on the usage limit.
 */
async function chat(run: Run, input: LongChat, verify?: string) {
	const first = await chatOnce(run, input, verify);
	if (first.result.state === "completed" || run.usageLimit || run.stopped())
		return first;
	console.log(
		`${tagFor(run)} ${input.id}: ${first.result.state} (${first.result.errors.join("; ").slice(0, 200)}); retrying once`,
	);
	const second = await chatOnce(run, input, verify);
	second.result.errors.unshift(
		`retried after: ${first.result.state} ${first.result.errors.join("; ").slice(0, 300)}`,
	);
	return second;
}

async function chatOnce(run: Run, input: LongChat, verify?: string) {
	return withSlot(
		"codex",
		SLOT_LIMITS.codex,
		async () => {
			let prepared: Prepared | null = null;
			try {
				prepared = await prepareChat(run, input);
				const sm = run.sm
					? await supermemoryParts(run, input.prompt)
					: undefined;
				const sent = await sendPrepared(run, prepared, {
					extraParts: sm?.parts,
					verify,
				});
				if (sm) sent.result.smRecall = sm.recall;
				return sent;
			} catch (error) {
				const result = emptyResult(input.id, prepared?.sessionId ?? null);
				result.errors.push(errorText(error));
				return { result, items: [] as SessionItem[] };
			} finally {
				await releasePrepared(run, prepared);
			}
		},
		run.stopped,
	);
}

// ---------------------------------------------------------------------------
// Our memory repo: seed, snapshots, jobs

async function seedRepo(name: string, files: Record<string, string>) {
	const created = await runCommand("npx", [
		"wrangler",
		"artifacts",
		"repos",
		"create",
		name,
		"--namespace",
		MEMORY_NAMESPACE,
		"--default-branch",
		"main",
		"--json",
	]);
	const { remote, token } = JSON.parse(created.stdout) as {
		remote: string;
		token: string;
	};
	const { pushChanges } = await import("../src/server/adapters/memory-repos");
	const http = (await import("isomorphic-git/http/web")).default;
	const outcome = await pushChanges({
		http,
		remote,
		token: token.split("?expires=")[0],
		base: { head: null, files: {} },
		changes: Object.entries(files).map(([path, content]) => ({
			path,
			content,
		})),
		message: "Seed memory for the eval",
	});
	if (outcome === "raced" || !outcome.ok)
		throw new Error(`Seeding ${name} failed.`);
}

type RepoSnapshot = {
	label: string;
	files: Record<string, string>;
	commits: string[];
};

/** The repo's files and commit subjects, through a short-lived read token. */
async function repoSnapshot(
	name: string,
	label: string,
): Promise<RepoSnapshot | null> {
	const dir = await mkdtemp(join(tmpdir(), "long-history-repo-"));
	try {
		const [info, token] = await Promise.all(
			[
				["get", name, "--namespace", MEMORY_NAMESPACE, "--json"],
				[
					"issue-token",
					name,
					"--namespace",
					MEMORY_NAMESPACE,
					"--scope",
					"read",
					"--ttl",
					"300",
					"--json",
				],
			].map(async (args) =>
				JSON.parse(
					(
						await runCommand(
							"npx",
							["wrangler", "artifacts", "repos", ...args],
							{
								timeout: 60_000,
							},
						)
					).stdout,
				),
			),
		);
		const remote = String(info.remote ?? "");
		const secret = String(token.plaintext ?? token.token ?? "").split(
			"?expires=",
		)[0];
		if (!remote.startsWith("https://") || !secret) return null;
		await runCommand(
			"git",
			[
				"-c",
				`http.extraHeader=Authorization: Bearer ${secret}`,
				"clone",
				"-q",
				remote,
				dir,
			],
			{ timeout: 60_000 },
		);
		const files: Record<string, string> = {};
		const walk = async (at: string) => {
			for (const entry of await readdir(at, { withFileTypes: true })) {
				if (entry.name === ".git") continue;
				const path = join(at, entry.name);
				if (entry.isDirectory()) await walk(path);
				else files[relative(dir, path)] = await readFile(path, "utf8");
			}
		};
		await walk(dir);
		const log = await runCommand("git", ["-C", dir, "log", "--format=%s"]);
		return { label, files, commits: log.stdout.split("\n").filter(Boolean) };
	} catch (error) {
		console.warn(`Snapshot ${label} failed: ${errorText(error)}`);
		return null;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Size and content of one snapshot: what is left of the seed's roles. */
function snapshotStats(snapshot: RepoSnapshot | null) {
	if (!snapshot) return null;
	const lines = memoryLines(snapshot.files).filter(
		(entry) => !/^\[\[.*\]\]$/.test(entry.text),
	);
	const texts = lines.map((entry) => entry.text);
	const present = (role: string) =>
		HISTORY.filter(
			(entry) =>
				entry.role === role && texts.some((text) => text === entry.text),
		).length;
	const fresh = [...PROBES, ...FRESHNESS.map((pair) => pair.probe)];
	return {
		label: snapshot.label,
		files: Object.keys(snapshot.files).filter((path) => path.endsWith(".md"))
			.length,
		lines: lines.length,
		chars: Object.values(snapshot.files).reduce(
			(total, content) => total + content.length,
			0,
		),
		memoryMdChars: snapshot.files["MEMORY.md"]?.length ?? 0,
		memoryMdLines: memoryLines({
			"MEMORY.md": snapshot.files["MEMORY.md"] ?? "",
		}).length,
		supersededLeft: present("superseded"),
		expiredLeft: present("expired"),
		nearDuplicatesLeft: present("near-duplicate"),
		seedLinesLeft: HISTORY.filter((entry) => texts.includes(entry.text)).length,
		newLines: lines.filter(
			(entry) => !HISTORY.some((seed) => seed.text === entry.text),
		).length,
		/** Probe facts the repo states (the probe's `right` pattern). */
		factsPresent: fresh
			.filter((probe) => texts.some((text) => probe.right.test(text)))
			.map((probe) => probe.id),
		commits: snapshot.commits.length,
	};
}

async function waitForSave(run: Run, sessionId: string, timeoutMs = 150_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = (
			await run.env.db.query<{ outcome: string; created_at: Date }>(
				"select outcome,created_at from memory_model_usage where user_id=$1 and kind='save' and session_id=$2 order by created_at desc limit 1",
				[run.user.userId, sessionId],
			)
		).rows[0];
		if (row) return { outcome: row.outcome, at: row.created_at.getTime() };
		await delay(3000);
	}
	return null;
}

async function dreamNow(run: Run) {
	const after = new Date();
	await run.env.dispatchBackgroundJob({
		id: randomUUID(),
		kind: "memory",
		action: "dream",
		userId: run.user.userId,
	});
	const deadline = Date.now() + run.dreamTimeoutMs;
	while (Date.now() < deadline) {
		const row = (
			await run.env.db.query<{ outcome: string }>(
				"select outcome from memory_model_usage where user_id=$1 and kind='dream' and created_at>$2 order by created_at desc limit 1",
				[run.user.userId, after],
			)
		).rows[0];
		if (row) {
			// The usage row lands before the commit; give the commit a moment.
			await delay(5000);
			return row.outcome;
		}
		await delay(5000);
	}
	return "timeout";
}

async function memoryCosts(run: Run, since: Date) {
	return (
		await run.env.db.query<{
			kind: string;
			calls: string;
			input: string | null;
			output: string | null;
			cached: string | null;
		}>(
			`select kind,count(*) as calls,sum(input_tokens) as input,sum(output_tokens) as output,sum(cache_read_tokens) as cached
			 from memory_model_usage where user_id=$1 and created_at>$2 group by kind order by kind`,
			[run.user.userId, since],
		)
	).rows.map((row) => ({
		kind: row.kind,
		calls: Number(row.calls),
		inputTokens: Number(row.input ?? 0),
		outputTokens: Number(row.output ?? 0),
		cachedTokens: Number(row.cached ?? 0),
	}));
}

// ---------------------------------------------------------------------------
// One arm

type UpdateRecord = {
	chat: ChatResult;
	save?: { outcome: string; afterSettleMs: number } | null;
	dream?: string;
	capture?: {
		docId: string | null;
		chars: number;
		settled: boolean;
		processMs: number;
		polls: { atMs: number; status: string }[];
	};
};

type ProbeRecord = ChatResult & {
	type: string;
	fact: string;
	injectedRight: boolean;
	injectedStale: boolean;
	injectedChars: number;
};

type FreshnessRecord = {
	id: string;
	update: ChatResult;
	probe: ProbeRecord;
	/** From the update turn's end to the probe's send. */
	gapMs: number | null;
	/** Ours: the update chat's save hook. */
	save?: { outcome: string; relativeToProbeSendMs: number } | null;
	/** Supermemory: the capture and its processing, relative to the capture. */
	capture?: {
		docId: string | null;
		addMs: number;
		statusAtProbe: string;
		polls: { atMs: number; status: string }[];
		processedMs: number | null;
		/** Whether the recall for the probe prompt finds the fact once processed. */
		recallAfterProcessed: boolean | null;
		recallAfterProcessedText: string;
	};
};

type ArmOutput = {
	arm: Arm;
	model: string;
	effort: string;
	startedAt: string;
	elapsedMs: number;
	evalUser: string;
	repo: string | null;
	containerTag: string | null;
	seed: {
		lines: number;
		files: number;
		ms: number;
		documents?: {
			month: string;
			settled: boolean;
			processMs: number;
			status: string;
		}[];
	};
	updates: UpdateRecord[];
	probes: ProbeRecord[];
	freshness: FreshnessRecord[];
	snapshots: ReturnType<typeof snapshotStats>[];
	repoFiles: Record<string, Record<string, string>>;
	costs: Awaited<ReturnType<typeof memoryCosts>>;
	smOps: SmOp[];
	smFinal?: { profile: ProfileResponse["profile"] | null; deleted: string };
	usageLimit: string | null;
	cleanup: string[];
	errors: string[];
};

function probeRecord(probe: Probe, chat: ChatResult): ProbeRecord {
	return {
		...chat,
		type: probe.type,
		fact: probe.fact,
		injectedRight: probe.right.test(chat.injected),
		injectedStale: probe.stale ? probe.stale.test(chat.injected) : false,
		injectedChars: chat.injected.length,
	};
}

const tagFor = (run: Run) => `[${run.arm}]`;

async function seedArm(run: Run, output: ArmOutput) {
	const begun = Date.now();
	if (run.arm === "ours") {
		const repo = run.repo as string;
		await run.user.setMemory("full", repo);
		await seedRepo(repo, seedFiles());
		const snapshot = await repoSnapshot(repo, "seed");
		output.snapshots.push(snapshotStats(snapshot));
		if (snapshot) output.repoFiles.seed = snapshot.files;
	} else {
		await run.user.setMemory("off", null);
		output.seed.documents = [];
		for (const doc of supermemorySeedDocuments()) {
			const added = await addSmDocument(
				run,
				doc.content,
				`seed-${doc.month}-${randomUUID().slice(0, 8)}`,
				{
					type: "session_turn",
					timestamp: doc.timestamp,
				},
			);
			// Oldest first, each processed before the next, so later
			// statements arrive after the ones they replace.
			const polled = await pollDocument(run, added.id, run.smWaitMs);
			output.seed.documents.push({
				month: doc.month,
				settled: polled.settled,
				processMs: polled.ms,
				status: polled.status,
			});
			console.log(
				`${tagFor(run)} seed ${doc.month}: ${polled.status} in ${Math.round(polled.ms / 1000)}s`,
			);
		}
	}
	output.seed.ms = Date.now() - begun;
}

async function runUpdates(run: Run, output: ArmOutput, updates: LongChat[]) {
	for (const update of updates) {
		if (run.stopped() || run.usageLimit) return;
		const turnStarted = new Date().toISOString();
		const { result, items } = await chat(run, update);
		const record: UpdateRecord = { chat: result };
		output.updates.push(record);
		if (run.usageLimit) return;
		if (run.arm === "ours" && result.sessionId) {
			const save = await waitForSave(run, result.sessionId);
			record.save = save
				? {
						outcome: save.outcome,
						afterSettleMs: save.at - (result.settledAt ?? save.at),
					}
				: null;
			record.dream = await dreamNow(run);
		} else if (run.sm) {
			const content = captureText(items, turnStarted);
			if (content && result.sessionId) {
				const added = await addSmDocument(run, content, result.sessionId, {
					type: "session_turn",
				});
				const polled = await pollDocument(run, added.id, run.smWaitMs);
				record.capture = {
					docId: added.id,
					chars: content.length,
					settled: polled.settled,
					processMs: polled.ms,
					polls: polled.polls,
				};
			}
		}
		console.log(
			`${tagFor(run)} update ${update.id}: ${result.state}${result.errors.length ? ` (${result.errors.join("; ")})` : ""}; ${record.save !== undefined ? `save ${record.save?.outcome ?? "none"}, dream ${record.dream}` : `capture ${record.capture ? `${record.capture.polls.map((p) => p.status).join(">")} ${Math.round(record.capture.processMs / 1000)}s` : "none"}`}`,
		);
	}
}

async function runProbes(
	run: Run,
	output: ArmOutput,
	probes: Probe[],
	concurrency: number,
) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(concurrency, probes.length) }, async () => {
			while (next < probes.length && !run.stopped() && !run.usageLimit) {
				const probe = probes[next++];
				const { result } = await chat(run, probe, probe.verify);
				const record = probeRecord(probe, result);
				output.probes.push(record);
				console.log(
					`${tagFor(run)} probe ${probe.id} (${probe.type}): ${record.passed === null ? "no verdict" : record.passed ? "PASS" : `fail: ${record.verifierOutput.split("\n").pop()}`}; injected ${record.injectedChars} chars, right ${record.injectedRight ? "yes" : "no"}, stale ${record.injectedStale ? "yes" : "no"}${record.expiredLeak ? `; EXPIRED: ${record.expiredLeak}` : ""}${record.errors.length ? `; errors: ${record.errors.join("; ")}` : ""}`,
				);
			}
		}),
	);
}

/** One freshness pair: the probe's VM waits while the update runs. */
async function runFreshnessPair(
	run: Run,
	pair: (typeof FRESHNESS)[number],
): Promise<FreshnessRecord | null> {
	return withSlot(
		"codex",
		SLOT_LIMITS.codex,
		async () => {
			let updatePrepared: Prepared | null = null;
			let probePrepared: Prepared | null = null;
			try {
				const turnStarted = new Date().toISOString();
				// The probe's VM idles through the update chat.
				const probeReady = prepareChat(
					run,
					pair.probe,
					Math.ceil(run.turnTimeoutMs / 1000) + 600,
				);
				updatePrepared = await prepareChat(run, pair.update);
				const updateParts = run.sm
					? await supermemoryParts(run, pair.update.prompt)
					: undefined;
				const update = await sendPrepared(run, updatePrepared, {
					extraParts: updateParts?.parts,
				});
				if (updateParts) update.result.smRecall = updateParts.recall;
				probePrepared = await probeReady;
				if (run.usageLimit) return null;
				const record: Partial<FreshnessRecord> = {
					id: pair.probe.id,
					update: update.result,
				};
				let captureAt = 0;
				let docId: string | null = null;
				if (run.sm) {
					const content = captureText(update.items, turnStarted);
					captureAt = Date.now();
					if (content && update.result.sessionId)
						docId = (
							await addSmDocument(run, content, update.result.sessionId, {
								type: "session_turn",
							})
						).id;
				}
				const addMs = run.sm ? Date.now() - captureAt : 0;
				// Status right before the probe's recall, then the probe at once.
				const statusAtProbe =
					run.sm && docId
						? await (run.sm as Sm).document(docId).then(
								(doc) =>
									`${doc.status ?? "unknown"}${doc.dreamingStatus ? `/${doc.dreamingStatus}` : ""}`,
								(error: Error) => `error:${error.message.slice(0, 60)}`,
							)
						: "";
				const probeParts = run.sm
					? await supermemoryParts(run, pair.probe.prompt)
					: undefined;
				const polling =
					run.sm && docId
						? pollDocument(run, docId, run.smWaitMs)
						: Promise.resolve(null);
				const probe = await sendPrepared(run, probePrepared, {
					extraParts: probeParts?.parts,
					verify: pair.probe.verify,
				});
				if (probeParts) probe.result.smRecall = probeParts.recall;
				record.probe = probeRecord(pair.probe, probe.result);
				record.gapMs =
					probe.result.sentAt && update.result.settledAt
						? probe.result.sentAt - update.result.settledAt
						: null;
				if (run.arm === "ours" && update.result.sessionId) {
					const save = await waitForSave(run, update.result.sessionId);
					record.save = save
						? {
								outcome: save.outcome,
								relativeToProbeSendMs:
									save.at - (probe.result.sentAt ?? save.at),
							}
						: null;
				}
				if (run.sm) {
					const polled = await polling;
					let after: Awaited<ReturnType<typeof supermemoryParts>> | null = null;
					if (polled?.settled)
						after = await supermemoryParts(run, pair.probe.prompt);
					const afterText = after?.parts.join("\n") ?? "";
					record.capture = {
						docId,
						addMs,
						statusAtProbe,
						polls: polled?.polls ?? [],
						processedMs: polled?.settled ? polled.ms : null,
						recallAfterProcessed: after
							? pair.probe.right.test(afterText)
							: null,
						recallAfterProcessedText: afterText.slice(0, 3000),
					};
				}
				const done = record as FreshnessRecord;
				console.log(
					`${tagFor(run)} freshness ${pair.probe.id}: ${done.probe.passed ? "PASS" : `fail: ${done.probe.verifierOutput.split("\n").pop()}`}; gap ${Math.round((done.gapMs ?? 0) / 1000)}s; injected right ${done.probe.injectedRight ? "yes" : "no"}${done.save !== undefined ? `; save ${done.save?.outcome ?? "none"} at ${Math.round((done.save?.relativeToProbeSendMs ?? 0) / 1000)}s vs probe send` : ""}${done.capture ? `; status at probe ${done.capture.statusAtProbe}, processed in ${done.capture.processedMs === null ? "-" : `${Math.round(done.capture.processedMs / 1000)}s`}, recall after ${done.capture.recallAfterProcessed}` : ""}`,
				);
				return done;
			} catch (error) {
				console.error(
					`${tagFor(run)} freshness ${pair.probe.id}: ${errorText(error)}`,
				);
				return null;
			} finally {
				await releasePrepared(run, updatePrepared);
				await releasePrepared(run, probePrepared);
			}
		},
		run.stopped,
	);
}

async function live() {
	const arm = flags.arm as Arm;
	if (!ARMS.includes(arm))
		throw new Error(`--arm accepts ${ARMS.join(", ")} (one arm per process).`);
	const model = flags.model;
	const effort = flags.effort;
	if (!/^[a-z0-9._-]+$/.test(model) || !/^[a-z]+$/.test(effort))
		throw new Error("Invalid --model or --effort.");
	const updates = subset(UPDATES, flags.updates);
	const probes = subset(PROBES, flags.probes);
	const freshness = subset(
		FRESHNESS.map((pair) => ({ ...pair, id: pair.probe.id })),
		flags.freshness,
	);
	const sm =
		arm === "ours" ? null : supermemoryClient(await supermemoryApiKey());
	const env = await liveEnvironment();
	await openExecutorGate(env);
	let stopping = false;
	onEvalStop(() => {
		stopping = true;
	});
	const startedAt = new Date();
	const user = await createEvalUser({ label: `memory-long-history ${arm}` });
	const run: Run = {
		arm,
		env,
		user,
		model,
		effort,
		turnTimeoutMs:
			Math.min(900, Math.max(60, Number(flags["turn-timeout"]) || 420)) * 1000,
		dreamTimeoutMs:
			Math.min(900, Math.max(60, Number(flags["dream-timeout"]) || 600)) * 1000,
		smWaitMs:
			Math.min(3600, Math.max(30, Number(flags["sm-wait"]) || 900)) * 1000,
		sm,
		smOps: [],
		containerTag: sm ? `ytimesy-eval-lh-${randomUUID().slice(0, 8)}` : null,
		repo: sm ? null : `memory-eval-lh-${randomUUID().slice(0, 8)}`,
		liveVms: new Set(),
		stopped: () => stopping,
		usageLimit: null,
	};
	const stats = historyStats();
	const output: ArmOutput = {
		arm,
		model,
		effort,
		startedAt: startedAt.toISOString(),
		elapsedMs: 0,
		evalUser: user.userId,
		repo: run.repo,
		containerTag: run.containerTag,
		seed: { lines: stats.lines, files: stats.files, ms: 0 },
		updates: [],
		probes: [],
		freshness: [],
		snapshots: [],
		repoFiles: {},
		costs: [],
		smOps: run.smOps,
		usageLimit: null,
		cleanup: [],
		errors: [],
	};
	const out =
		flags.out ??
		`/tmp/memory-long-history-${arm}-${startedAt.toISOString().replaceAll(/[:.]/g, "-")}.json`;
	const save = () => writeFile(out, JSON.stringify(output, null, 2));
	console.log(
		`${tagFor(run)} eval user ${user.userId}; ${updates.length} updates, ${probes.length} probes, ${freshness.length} freshness pairs; ${run.repo ?? run.containerTag}; output ${out}`,
	);
	try {
		await seedArm(run, output);
		await save();
		await runUpdates(run, output, updates);
		await save();
		if (run.repo) {
			const snapshot = await repoSnapshot(run.repo, "after-updates");
			output.snapshots.push(snapshotStats(snapshot));
			if (snapshot) output.repoFiles["after-updates"] = snapshot.files;
		}
		if (!run.usageLimit)
			await runProbes(
				run,
				output,
				probes,
				Math.min(4, Math.max(1, Number(flags["probe-concurrency"]) || 3)),
			);
		await save();
		for (const pair of freshness) {
			if (run.stopped() || run.usageLimit) break;
			const record = await runFreshnessPair(run, pair);
			if (record) output.freshness.push(record);
			await save();
		}
		if (run.repo) {
			// Probe and freshness save hooks may still be landing.
			await delay(20_000);
			const snapshot = await repoSnapshot(run.repo, "end");
			output.snapshots.push(snapshotStats(snapshot));
			if (snapshot) output.repoFiles.end = snapshot.files;
		}
		output.costs = await memoryCosts(run, startedAt);
		if (sm && run.containerTag) {
			const profile = await sm
				.profile(run.containerTag, user.project.dirName)
				.catch(() => null);
			output.smFinal = { profile: profile?.profile ?? null, deleted: "" };
		}
	} catch (error) {
		output.errors.push(errorText(error));
		console.error(`${tagFor(run)} ${errorText(error)}`);
	} finally {
		output.usageLimit = run.usageLimit;
		for (const id of run.liveVms)
			await env.client.vms.delete(id).catch(() => {});
		if (sm && run.containerTag) {
			const deleted = await sm.deleteContainer(run.containerTag).then(
				(done) =>
					`deleted ${done.deletedDocumentsCount} documents, ${done.deletedMemoriesCount} memories`,
				(error: Error) => `cleanup failed: ${error.message}`,
			);
			output.smFinal = { profile: output.smFinal?.profile ?? null, deleted };
			output.cleanup.push(`container ${run.containerTag}: ${deleted}`);
		}
		const left = await user.release();
		output.cleanup.push(
			left.length
				? `eval user cleanup incomplete: ${left.join(", ")}`
				: `eval user ${user.userId} released (VMs, repo ${run.repo ?? "-"})`,
		);
		output.elapsedMs = Date.now() - startedAt.getTime();
		await save();
		await env.closeDatabase();
	}
	if (run.usageLimit)
		console.log(
			`${tagFor(run)} STOPPED on the Codex usage limit: ${run.usageLimit}`,
		);
	console.log(`${output.cleanup.join("\n")}\nWrote ${out}`);
	printReport([output]);
}

// ---------------------------------------------------------------------------
// --report

function printReport(outputs: ArmOutput[]) {
	const pct = (part: number, whole: number) =>
		whole ? `${part}/${whole}` : "-";
	const types = [
		"exception",
		"latest-seed",
		"latest-update",
		"indirect",
		"expired",
		"old-valid",
	];
	const summary = [
		[
			"arm",
			"probes pass",
			...types,
			"right injected",
			"stale injected",
			"expired leaks",
			"avg injected chars",
			"freshness pass",
		],
	];
	for (const output of outputs) {
		const probes = output.probes;
		summary.push([
			output.arm,
			pct(probes.filter((row) => row.passed).length, probes.length),
			...types.map((type) => {
				const rows = probes.filter((row) => row.type === type);
				return pct(rows.filter((row) => row.passed).length, rows.length);
			}),
			pct(probes.filter((row) => row.injectedRight).length, probes.length),
			pct(probes.filter((row) => row.injectedStale).length, probes.length),
			String(
				[...probes, ...output.freshness.map((row) => row.probe)].filter(
					(row) => row.expiredLeak,
				).length,
			),
			String(
				Math.round(
					probes.reduce((total, row) => total + row.injectedChars, 0) /
						Math.max(1, probes.length),
				),
			),
			pct(
				output.freshness.filter((row) => row.probe.passed).length,
				output.freshness.length,
			),
		]);
	}
	console.log(`\n${table(summary)}`);
	const ids = [...new Set(outputs.flatMap((o) => o.probes.map((p) => p.id)))];
	const matrix = [
		["probe", "type", ...outputs.map((o) => o.arm)],
		...ids.map((id) => {
			const type =
				outputs.flatMap((o) => o.probes).find((p) => p.id === id)?.type ?? "";
			return [
				id,
				type,
				...outputs.map((o) => {
					const row = o.probes.find((p) => p.id === id);
					if (!row) return "-";
					return `${row.passed === null ? "?" : row.passed ? "PASS" : "fail"} r${row.injectedRight ? 1 : 0}s${row.injectedStale ? 1 : 0} g${row.memoryToolCalls}`;
				}),
			];
		}),
	];
	console.log(
		`\n${table(matrix)}\n(r = current fact in the injected memory, s = a stale version in it, g = builder tool calls on ~/memory)`,
	);
	const fresh = [
		[
			"arm",
			"probe",
			"pass",
			"gap s",
			"right injected",
			"save vs send s",
			"status at probe",
			"processed s",
			"recall after",
		],
	];
	for (const output of outputs)
		for (const row of output.freshness)
			fresh.push([
				output.arm,
				row.id,
				row.probe.passed ? "PASS" : "fail",
				String(Math.round((row.gapMs ?? 0) / 1000)),
				row.probe.injectedRight ? "yes" : "no",
				row.save === undefined
					? "-"
					: row.save
						? `${row.save.outcome} ${Math.round(row.save.relativeToProbeSendMs / 1000)}`
						: "none",
				row.capture?.statusAtProbe ?? "-",
				row.capture?.processedMs == null
					? "-"
					: String(Math.round(row.capture.processedMs / 1000)),
				row.capture?.recallAfterProcessed == null
					? "-"
					: String(row.capture.recallAfterProcessed),
			]);
	if (fresh.length > 1) console.log(`\n${table(fresh)}`);
	const sizes = [
		[
			"arm",
			"snapshot",
			"files",
			"lines",
			"MEMORY.md chars",
			"superseded left",
			"expired left",
			"near-dups left",
			"new lines",
			"facts present",
		],
	];
	for (const output of outputs)
		for (const snap of output.snapshots)
			if (snap)
				sizes.push([
					output.arm,
					snap.label,
					String(snap.files),
					String(snap.lines),
					String(snap.memoryMdChars),
					String(snap.supersededLeft),
					String(snap.expiredLeft),
					String(snap.nearDuplicatesLeft),
					String(snap.newLines),
					snap.factsPresent.join(","),
				]);
	if (sizes.length > 1) console.log(`\n${table(sizes)}`);
	for (const output of outputs) {
		const hooks = [
			...output.probes,
			...output.freshness.map((row) => row.probe),
		].flatMap((row) => (row.hook ? [row.hook] : []));
		if (hooks.length) {
			const outcomes = new Map<string, number>();
			for (const hook of hooks)
				outcomes.set(hook.outcome, (outcomes.get(hook.outcome) ?? 0) + 1);
			const ms = hooks.map((hook) => hook.ms).sort((a, b) => a - b);
			console.log(
				`\n${output.arm} read hook: ${[...outcomes].map(([outcome, count]) => `${outcome} ${count}`).join(", ")}; median ${ms[Math.floor(ms.length / 2)]}ms, max ${ms[ms.length - 1]}ms`,
			);
		}
		if (output.costs.length)
			console.log(
				`\n${output.arm} memory jobs: ${output.costs.map((c) => `${c.kind} ${c.calls} calls, ${c.inputTokens} in (${c.cachedTokens} cached) / ${c.outputTokens} out`).join("; ")}`,
			);
		if (output.smOps.length) {
			const byOp = new Map<string, number[]>();
			for (const op of output.smOps)
				byOp.set(op.op, [...(byOp.get(op.op) ?? []), op.ms]);
			console.log(
				`\n${output.arm} Supermemory ops: ${[...byOp.entries()]
					.map(([op, ms]) => {
						const sorted = [...ms].sort((a, b) => a - b);
						return `${op} ${ms.length}x median ${sorted[Math.floor(sorted.length / 2)]}ms max ${sorted[sorted.length - 1]}ms`;
					})
					.join("; ")}; failures ${output.smOps.filter((op) => !op.ok).length}`,
			);
		}
		if (output.seed.documents)
			console.log(
				`${output.arm} seed processing: ${output.seed.documents.map((d) => `${d.month} ${Math.round(d.processMs / 1000)}s ${d.status}`).join(", ")}`,
			);
		const updates = output.updates.map(
			(u) =>
				`${u.chat.id} ${u.chat.state}${u.save !== undefined ? ` save=${u.save?.outcome ?? "none"} dream=${u.dream}` : ""}${u.capture ? ` processed ${Math.round(u.capture.processMs / 1000)}s` : ""}`,
		);
		console.log(`${output.arm} updates: ${updates.join("; ")}`);
		if (output.usageLimit)
			console.log(`${output.arm} usage limit: ${output.usageLimit}`);
		console.log(`${output.arm} cleanup: ${output.cleanup.join("; ")}`);
	}
}

async function report() {
	const outputs = await Promise.all(
		(flags.report ?? "")
			.split(",")
			.filter(Boolean)
			.map(
				async (path) => JSON.parse(await readFile(path, "utf8")) as ArmOutput,
			),
	);
	printReport(outputs);
}

// ---------------------------------------------------------------------------
// --recall-check: was a miss the ranking or the hook's timeout?

async function recallCheck() {
	const { CLOUDFLARE_ACCOUNT_ID } = await import("./development-config");
	process.env.CLOUDFLARE_ACCOUNT_ID ||= CLOUDFLARE_ACCOUNT_ID;
	const { memoryEmbedder } = await import(
		"../src/server/adapters/memory-embeddings"
	);
	const {
		cosineSimilarity,
		memoryLineEmbeddingText,
		MEMORY_MATCH_LIMIT,
		MEMORY_MATCH_MIN_SCORE,
		selectMemoryMatches,
		memoryQueryText,
	} = await import("../src/domain/memory-repo");
	const { memoryMatchScores } = await import("../src/domain/memory-ranking");
	const embed = memoryEmbedder();
	if (!embed)
		throw new Error("Set CLOUDFLARE_API_TOKEN (npx wrangler auth token).");
	const output = JSON.parse(
		await readFile(flags["recall-check"] as string, "utf8"),
	) as ArmOutput;
	const rows = [
		[
			"probe",
			"snapshot",
			"cosine rank",
			"hybrid rank",
			"hybrid score",
			"selected",
			"top score",
			"live injected lines",
		],
	];
	const totals = { probes: 0, cosine5: 0, hybrid5: 0, selected: 0 };
	for (const label of ["after-updates", "end"]) {
		const files = output.repoFiles[label];
		if (!files) continue;
		const lines = memoryLines(files).filter(
			(entry) => entry.path !== "MEMORY.md",
		);
		const vectors = await embed.documents(lines.map(memoryLineEmbeddingText));
		for (const probe of [...PROBES, ...FRESHNESS.map((pair) => pair.probe)]) {
			const live =
				output.probes.find((row) => row.id === probe.id) ??
				output.freshness.find((row) => row.id === probe.id)?.probe;
			const query = memoryQueryText(`${probe.prompt}${PROMPT_SUFFIX}`);
			if (!query) continue;
			const vector = await embed.query(query);
			const similarity = new Map(
				lines.map((entry, index) => [
					entry,
					cosineSimilarity(vector, vectors[index]),
				]),
			);
			const scores = memoryMatchScores(lines, similarity, query);
			const rankBy = (by: Map<(typeof lines)[number], number>) =>
				[...lines]
					.sort((a, b) => (by.get(b) ?? 0) - (by.get(a) ?? 0))
					.findIndex((entry) => probe.right.test(entry.text)) + 1;
			const cosineRank = rankBy(similarity);
			const rank = rankBy(scores);
			const ranked = [...lines].sort(
				(a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
			);
			const selected = selectMemoryMatches({
				lines,
				scores,
				alreadyShown: () => false,
				today: memoryToday(),
				project: null,
			}).some((entry) => probe.right.test(entry.text));
			if (rank) {
				totals.probes++;
				if (cosineRank <= 5) totals.cosine5++;
				if (rank <= 5) totals.hybrid5++;
				if (selected) totals.selected++;
			}
			const liveLines = live
				? (live.injected.split("apply to this message")[1] ?? "")
						.split("\n")
						.filter((row) => /^[\w/.-]+\.md:\d+:/.test(row)).length
				: 0;
			rows.push([
				probe.id,
				label,
				cosineRank ? String(cosineRank) : "-",
				rank ? String(rank) : "-",
				rank ? (scores.get(ranked[rank - 1]) ?? 0).toFixed(3) : "-",
				selected ? "yes" : "no",
				(scores.get(ranked[0]) ?? 0).toFixed(3),
				String(liveLines),
			]);
		}
	}
	console.log(table(rows));
	console.log(
		`Probes whose fact is in the snapshot: ${totals.probes}; recall@5 cosine ${totals.cosine5}, hybrid ${totals.hybrid5}; selected by the read hook (top ${MEMORY_MATCH_LIMIT}, score >= ${MEMORY_MATCH_MIN_SCORE}) ${totals.selected}. "live injected lines" = read-hook lines the probe actually got in that run.`,
	);
}

// ---------------------------------------------------------------------------
// --hook-latency: the read hook on the seeded history, from this machine.

async function hookLatency() {
	const { CLOUDFLARE_ACCOUNT_ID } = await import("./development-config");
	process.env.CLOUDFLARE_ACCOUNT_ID ||= CLOUDFLARE_ACCOUNT_ID;
	const { memoryEmbedder, resetWarmLineEmbeddings } = await import(
		"../src/server/adapters/memory-embeddings"
	);
	const { readHook, recallableLines } = await import(
		"../src/server/services/turn-memory"
	);
	const embed = memoryEmbedder();
	if (!embed)
		throw new Error("Set CLOUDFLARE_API_TOKEN (npx wrangler auth token).");
	const snapshot = { head: "seed", files: seedFiles() };
	// A database stand-in: vectors stored as JSON text, parsed on every load.
	const stored = new Map<string, string>();
	const cache = {
		load: async (_user: string, _model: string, hashes: readonly string[]) =>
			new Map(
				hashes.flatMap((hash) => {
					const row = stored.get(hash);
					return row ? [[hash, JSON.parse(row) as number[]] as const] : [];
				}),
			),
		save: async (
			_user: string,
			_model: string,
			rows: readonly { hash: string; embedding: readonly number[] }[],
		) => {
			for (const row of rows)
				stored.set(row.hash, JSON.stringify(row.embedding));
		},
	};
	const rows = [["case", "probe", "outcome", "ms"]];
	const run = async (label: string, prompt: string) => {
		const result = await readHook({
			snapshot,
			embed,
			userId: "latency",
			query: `${prompt}${PROMPT_SUFFIX}`,
			alreadyShown: () => false,
			today: memoryToday(),
			project: null,
			cache,
			timeoutMs: 60_000,
		});
		rows.push([label, prompt.slice(0, 40), result.outcome, String(result.ms)]);
	};
	const lines = recallableLines(snapshot).length;
	await run(`cold (embed ${lines} lines)`, PROBES[0].prompt);
	for (const probe of PROBES.slice(1, 4)) {
		resetWarmLineEmbeddings();
		await run("database-warm", probe.prompt);
	}
	for (const probe of PROBES.slice(4, 7))
		await run("isolate-warm", probe.prompt);
	console.log(table(rows));
}

if (flags["dry-run"]) await dryRun();
else if (flags["hook-latency"]) await hookLatency();
else if (flags["recall-check"]) await recallCheck();
else if (flags.report) await report();
else if (flags.live) await live();
else
	throw new Error(
		"Pass --dry-run (verifiers), --live --arm <arm> (one arm) or --report <json,...>.",
	);
if (flags.live) process.exit(process.exitCode ?? 0);
