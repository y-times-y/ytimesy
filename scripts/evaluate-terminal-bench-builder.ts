import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactEvaluationText } from "../benchmarks/evaluation/artifacts";
import { evaluationBuilderContext } from "../benchmarks/evaluation/builder-context";
import { evaluationBuilderTools } from "../benchmarks/evaluation/builder-tools";
import { localContextArchives } from "../benchmarks/evaluation/local-context-archives";
import { createOperatorEvaluationDatabase } from "../benchmarks/evaluation/operator-database";
import { createTerminalBenchMachines } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";
import {
	evaluationObservedTokens,
	evaluationTokenUsage,
} from "../benchmarks/evaluation/token-usage";
import type { ApiAgentEvent } from "../src/domain/api-agent-event";
import type { HarnessModelMetric } from "../src/domain/harness-performance";
import { codexSubscriptionModel } from "../src/server/adapters/codex-subscription";
import {
	archiveModelContext,
	readModelContextArchive,
} from "../src/server/adapters/context-archives";
import { closeDatabase } from "../src/server/adapters/database";
import { nativeModelCompactor } from "../src/server/adapters/model-compaction";
import { stopApiTurnCommands } from "../src/server/services/api-command-scope";
import { runModelAgent } from "../src/server/services/model-agent-loop";

const [taskPath, outputPath, mode] = process.argv.slice(2);
if (!taskPath || !outputPath || !["preflight", "run"].includes(mode))
	throw new Error("Specify original task, private output, and preflight/run.");
if (
	mode === "run" &&
	process.env.YTIMESY_EVALUATION_APPROVED !== "codex-subscription"
)
	throw new Error("Subscription evaluation approval required.");
const output = resolve(outputPath);
if (!output.startsWith(`${resolve(".ytimesy")}/`))
	throw new Error("Evaluation output must remain private.");
try {
	await access(resolve(output, "..", "stop-new-tasks"));
	throw new Error("Operator stopped new tasks in this evaluation campaign.");
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Missing disposable compute connection.");
await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 });
await mkdir(output, { mode: 0o700 });
const save = (name: string, data: unknown) =>
	writeFile(
		`${output}/${name}.json`,
		redactEvaluationText(JSON.stringify(data, null, 2)),
		{ mode: 0o600 },
	);
const { task } = await loadTerminalBenchTask(resolve(taskPath));
console.log(
	`${task.id}: operator preflight (${mode}); no inference until guest prerequisites pass.`,
);
const runId = randomUUID();
const bridge = createTerminalBenchMachines({
	apiKey: key,
	runId,
	maxVms: 1,
	onResources: (resources) => save("resources", { runId, ...resources }),
});
const stop = new AbortController();
const cancel = () =>
	stop.abort(new Error("Operator stopped builder evaluation"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
if (!process.env.YTIMESY_EVALUATION_CODEX_AUTH_FILE)
	throw new Error(
		"This private pilot requires local Codex sign-in; remote database access is disabled.",
	);
const local = await createOperatorEvaluationDatabase(output);
process.env.DATABASE_URL = local.databaseUrl;
process.env.BETTER_AUTH_SECRET = local.secret;
let requests = 0;
const metrics: HarnessModelMetric[] = [];
const events: ApiAgentEvent[] = [];
const toolMetrics: unknown[] = [];
const sessionId = randomUUID();
const archives = localContextArchives(
	`${output}/context-archives`,
	local.userId,
	sessionId,
);
try {
	// Fail before VM allocation or inference if recoverable context is unavailable.
	const reference = await archiveModelContext(
		local.userId,
		sessionId,
		[],
		archives.storage,
	);
	const restored = await readModelContextArchive(
		local.userId,
		sessionId,
		reference,
		archives.storage,
	);
	if (restored.length) throw new Error("Archive preflight failed.");
	const prepared = await bridge.prepare(task);
	console.log(`${task.id}: pinned task guest prepared.`);
	await bridge.machines.ensureRunning(prepared.vmId);
	const signal = AbortSignal.any([
		stop.signal,
		AbortSignal.timeout(30 * 60_000),
	]);
	const workspace = {
		machines: bridge.machines,
		vm: prepared.vmId,
		cwd: "/app",
		signal,
		sessionId,
		turnId: randomUUID(),
	};
	const context = evaluationBuilderContext({
		tools: evaluationBuilderTools(workspace),
		storage: archives.storage,
		workspace,
		userId: local.userId,
		sessionId,
		signal,
		onEvent: async (event) => {
			events.push(event);
		},
	});
	const tools = context.tools;
	await save("protocol", {
		task: task.id,
		model: "gpt-6.1-sol",
		reasoning: "max",
		fast: false,
		billing: "codex-subscription",
		archiveBackend: "encrypted local pilot storage; no Supabase network calls",
		originalPrompt: task.instruction,
		image: task.image,
		resources: task.resources,
		guestPrerequisites: "git, python3, Node, and installed/exercised ripgrep",
		sourceSha256: task.sourceSha256,
		publicFastMode: "assumed off by operator; not verified",
		tools: Object.keys(tools),
		requestLimit: 128,
		timeoutSeconds: 1800,
		tokenLimit: 4000000,
		scope:
			"Builder model loop and actual repository tools only; no leader, delegation, review, publication, or production queue.",
	});
	const pristine = await bridge.machines.exec(
		prepared.vmId,
		"cd /app && git status --porcelain",
		15000,
	);
	if (pristine.exitCode || pristine.stdout.trim())
		throw new Error("Builder checkout is not pristine.");
	if (mode === "preflight") {
		await save("result", { preflight: true, requests: 0, noLeader: true });
	} else {
		const runtime = await codexSubscriptionModel(
			local.userId,
			"gpt-6.1-sol",
			"max",
			false,
			workspace.sessionId,
		);
		const model = runtime.model;
		if (typeof model === "string")
			throw new Error("Expected a concrete subscription transport.");
		runtime.model = new Proxy(model, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (property === "doStream" || property === "doGenerate")
					return async (...args: unknown[]) => {
						signal.throwIfAborted();
						const tokens = evaluationObservedTokens(events);
						if (requests >= 128 || tokens >= 4000000)
							throw new Error("Frozen evaluation guard reached.");
						requests++;
						await save("progress", { requests, observedTokens: tokens });
						return value.apply(target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		// Rebind native compaction to the guarded transport so its requests count too.
		runtime.compact = nativeModelCompactor(
			runtime.model,
			"openai",
			runtime.requestSettings,
		);
		const started = Date.now();
		console.log(`${task.id}: builder started; gpt-6.1-sol / max / Fast off.`);
		let failure: string | null = null;
		try {
			await runModelAgent(
				{
					userId: local.userId,
					modelId: "gpt-6.1-sol",
					reasoning: "max",
					toolSurface: "implementation",
					...context,
					signal,
					maxSteps: 128,
					messages: [{ role: "user", content: task.instruction }],
					instructions:
						"You are the ytimesy builder. Complete the user's task in /app. Use the repository tools for inspection, editing and verification. Read applicable repository guidance before editing. Do not publish, delegate, or access another project. Report the actual checks and any unresolved problems.",
					onEvent: async (event) => {
						events.push(event);
					},
					onStep: async () => {
						await save("trace", { events, metrics, toolMetrics });
					},
					onModelMetric: (metric) => metrics.push(metric),
					onToolMetric: (metric) => toolMetrics.push(metric),
				},
				runtime,
			);
		} catch (error) {
			failure = error instanceof Error ? error.message : "Builder failed";
		}
		const agentSeconds = (Date.now() - started) / 1000;
		console.log(
			`${task.id}: builder stopped after ${agentSeconds.toFixed(1)}s / ${requests} requests; running separate official grader.`,
		);
		await stopApiTurnCommands(workspace, workspace.turnId);
		await save("trace", { events, metrics, toolMetrics });
		const bytes = await bridge.exportArtifacts(prepared.vmId, task.artifacts);
		await writeFile(`${output}/artifacts.tar.gz`, bytes, { mode: 0o600 });
		const gradeOutput = `${output}/official-grade`;
		await mkdir(gradeOutput, { mode: 0o700 });
		const reward = await gradeTerminalBenchArtifact({
			apiKey: key,
			runId: randomUUID(),
			taskPath: resolve(taskPath),
			output: gradeOutput,
			artifacts: bytes,
			signal: stop.signal,
		});
		await save("result", {
			reward,
			failure,
			requests,
			agentSeconds,
			noLeader: true,
			...evaluationTokenUsage(events),
			usageAccounting: "cumulative usage including compaction",
		});
		console.log(
			`${task.id}: official reward ${reward}; failure ${failure ?? "none"}.`,
		);
	}
} catch (error) {
	await save("failure", {
		error: error instanceof Error ? error.message : "Evaluation failed",
		requests,
	});
	process.exitCode = 1;
} finally {
	const failures: string[] = [];
	for (const [label, operation] of [
		["owned context archives", () => archives.close()],
		["owned provider resources", () => bridge.cleanup()],
		["database connection", closeDatabase],
		["disposable database", () => local.close()],
	] as const) {
		try {
			await operation();
		} catch {
			failures.push(label);
		}
	}
	await save("cleanup", { complete: failures.length === 0, failures });
	process.off("SIGINT", cancel);
	process.off("SIGTERM", cancel);
	if (failures.length) process.exitCode = 1;
}
