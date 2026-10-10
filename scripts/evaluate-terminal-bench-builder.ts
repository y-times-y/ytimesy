import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactEvaluationText } from "../benchmarks/evaluation/artifacts";
import {
	bedrockClaudeRuntime,
	estimatedOpusCostUsd,
} from "../benchmarks/evaluation/bedrock-claude";
import { evaluationBuilderContext } from "../benchmarks/evaluation/builder-context";
import { evaluationBuilderTools } from "../benchmarks/evaluation/builder-tools";
import { localContextArchives } from "../benchmarks/evaluation/local-context-archives";
import {
	estimatedSolCostUsd,
	openAiSolRuntime,
} from "../benchmarks/evaluation/openai-sol";
import { createOperatorEvaluationDatabase } from "../benchmarks/evaluation/operator-database";
import {
	type EvaluationRequestObservation,
	observeEvaluationRequest,
} from "../benchmarks/evaluation/request-observation";
import { createTerminalBenchMachines } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";
import {
	evaluationObservedTokens,
	evaluationTokenUsage,
} from "../benchmarks/evaluation/token-usage";
import type { ApiAgentEvent } from "../src/domain/api-agent-event";
import { apiModelFailureClassification } from "../src/domain/api-turn-failure";
import type { HarnessModelMetric } from "../src/domain/harness-performance";
import { codexSubscriptionModel } from "../src/server/adapters/codex-subscription";
import {
	archiveModelContext,
	readModelContextArchive,
} from "../src/server/adapters/context-archives";
import { closeDatabase } from "../src/server/adapters/database";
import { nativeModelCompactor } from "../src/server/adapters/model-compaction";
import { stopApiTurnCommands } from "../src/server/services/api-command-scope";
import type { ModelAgentRuntime } from "../src/server/services/model-agent-loop";
import { runModelAgent } from "../src/server/services/model-agent-loop";

const [taskPath, outputPath, mode] = process.argv.slice(2);
if (!taskPath || !outputPath || !["preflight", "run"].includes(mode))
	throw new Error("Specify original task, private output, and preflight/run.");
// Each arm keeps its own billing approval; the Codex arm's frozen limits are unchanged.
const route =
	(["bedrock-opus", "openai-sol"] as const).find(
		(candidate) => candidate === process.env.YTIMESY_EVALUATION_ROUTE,
	) ?? "codex-subscription";
if (mode === "run" && process.env.YTIMESY_EVALUATION_APPROVED !== route)
	throw new Error(`Evaluation approval for ${route} required.`);
const trialUsdCap = Number(process.env.YTIMESY_EVALUATION_TRIAL_USD_CAP ?? 20);
const arm =
	route === "bedrock-opus"
		? {
				modelId: "anthropic.claude-opus-5-5",
				billing: "aws-bedrock",
				requestLimit: 400,
				tokenLimit: null,
				usdCap: trialUsdCap,
			}
		: route === "openai-sol"
			? {
					modelId: "gpt-6.1-sol",
					billing: "openai-api",
					requestLimit: 400,
					tokenLimit: null,
					usdCap: trialUsdCap,
				}
			: {
					modelId: "gpt-6.1-sol",
					billing: "codex-subscription",
					requestLimit: 128,
					tokenLimit: 4000000,
					usdCap: null,
				};
if (arm.usdCap !== null && !(arm.usdCap > 0 && arm.usdCap <= 100))
	throw new Error("Trial spending cap must be between $0 and $100.");
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
const requestObservations: EvaluationRequestObservation[] = [];
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
	// The Opus arm uses the task's official agent limit, as the public run did.
	const timeoutSeconds =
		route === "codex-subscription" ? 1800 : (task.agentTimeoutSeconds ?? 1800);
	const signal = AbortSignal.any([
		stop.signal,
		AbortSignal.timeout(timeoutSeconds * 1000),
	]);
	const workspace = {
		machines: bridge.machines,
		vm: prepared.vmId,
		cwd: "/app",
		signal,
		sessionId,
		turnId: randomUUID(),
	};
	// "shell" offers a native-Codex-shaped surface; the default keeps every tool.
	const toolset =
		process.env.YTIMESY_EVALUATION_TOOLSET === "shell" ? "shell" : "full";
	const builderTools = evaluationBuilderTools(workspace, {
		nativePatch: route === "openai-sol" && toolset === "shell",
	});
	const SHELL_TOOLS = new Set([
		"execute_command",
		"continue_command",
		"stop_command",
		"apply_patch",
		"view_image",
		"read_repository_guidance",
	]);
	const context = evaluationBuilderContext({
		tools:
			toolset === "shell"
				? Object.fromEntries(
						Object.entries(builderTools).filter(([name]) =>
							SHELL_TOOLS.has(name),
						),
					)
				: builderTools,
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
		model: arm.modelId,
		reasoning: "max",
		fast: false,
		billing: arm.billing,
		toolset,
		archiveBackend: "encrypted local pilot storage; no Supabase network calls",
		originalPrompt: task.instruction,
		image: task.image,
		resources: task.resources,
		guestPrerequisites: "git, python3, Node, and installed/exercised ripgrep",
		sourceSha256: task.sourceSha256,
		publicFastMode: "assumed off by operator; not verified",
		tools: Object.keys(tools),
		requestLimit: arm.requestLimit,
		timeoutSeconds,
		tokenLimit: arm.tokenLimit,
		trialUsdCap: arm.usdCap,
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
		const runtime: ModelAgentRuntime =
			route === "bedrock-opus"
				? await bedrockClaudeRuntime({ modelId: arm.modelId, effort: "max" })
				: route === "openai-sol"
					? await openAiSolRuntime({
							modelId: arm.modelId,
							effort: "max",
							cacheScope: workspace.sessionId,
						})
					: await codexSubscriptionModel(
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
						const estimatedUsd = (
							route === "openai-sol"
								? estimatedSolCostUsd
								: estimatedOpusCostUsd
						)(evaluationTokenUsage(events));
						if (
							requests >= arm.requestLimit ||
							(arm.tokenLimit !== null && tokens >= arm.tokenLimit) ||
							(arm.usdCap !== null && estimatedUsd >= arm.usdCap)
						)
							throw new Error("Frozen evaluation guard reached.");
						requests++;
						await save("progress", {
							requests,
							observedTokens: tokens,
							...(arm.usdCap !== null ? { estimatedUsd } : {}),
						});
						return observeEvaluationRequest(
							{ request: requests, method: property },
							() => value.apply(target, args),
							async (observation) => {
								requestObservations.push(observation);
								await save("request-attempts", requestObservations);
							},
						);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		// Rebind native compaction to the guarded transport so its requests count too.
		if (route !== "bedrock-opus" && runtime.requestSettings)
			runtime.compact = nativeModelCompactor(
				runtime.model,
				"openai",
				runtime.requestSettings,
			);
		const started = Date.now();
		console.log(
			`${task.id}: builder started; ${arm.modelId} / max / Fast off.`,
		);
		let failure: string | null = null;
		try {
			await runModelAgent(
				{
					userId: local.userId,
					modelId: arm.modelId,
					reasoning: "max",
					toolSurface: "implementation",
					...context,
					signal,
					maxSteps: arm.requestLimit,
					turnTimeoutMs: timeoutSeconds * 1000,
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
			await save("model-failure", apiModelFailureClassification(error));
		}
		const agentSeconds = (Date.now() - started) / 1000;
		console.log(
			`${task.id}: builder stopped after ${agentSeconds.toFixed(1)}s / ${requests} requests; running separate official grader.`,
		);
		await stopApiTurnCommands(workspace, workspace.turnId);
		await save("trace", { events, metrics, toolMetrics });
		const bytes = await bridge.exportArtifacts(
			prepared.vmId,
			task.artifacts,
			task.collectCommands,
		);
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
			usageCompleteness:
				failure ||
				requestObservations.some(
					(attempt) => attempt.outcome === "start_failed",
				)
					? "incomplete"
					: "reported",
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
