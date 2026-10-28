/**
 * Delegation probe: does the product's root builder start a subagent on
 * vague product requests? Measurement only; no harness change comes from it.
 *
 * Each run is one product builder turn (the root chat, subagents on, as
 * PRODUCT_HARNESS_VARIANT gives real users) against a fresh Docker copy of
 * the target repo. The setup is the Harbor bridge's in-process product
 * turn (harborHarness: the product's base tools, lean surface, repository
 * instructions as messages, hosted web search) with two changes so it is
 * the interactive product prompt rather than the bridge's:
 *   - the system prompt is agentTurnInstructions with unattended unset (no
 *     UNATTENDED_RUN_INSTRUCTIONS, no bridge helper section), and
 *   - the product's own `agent` / `agent_send` tools (subagentTools: the
 *     same descriptions and input schemas) are offered, so the prompt gets
 *     the product's orchestrator block for Main.
 * The agent tool's execute is a stub: the first call is recorded (role,
 * title, model request number) and the run is aborted; no child starts.
 *
 * Usage (from the arm's worktree, so the arm's own src/ is imported):
 *   tsx evals/delegation-probe/run.ts --arm strict --round 1 --ids 1,2 \
 *     --target <clone> --out <dir> [--concurrency 3]
 * Configuration: YTIMESY_HARBOR_* (route bedrock, model, effort, total cap
 * and ledger) as the bridge reads them; YTIMESY_PROBE_RUN_USD_CAP per run.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage, ToolSet } from "ai";
import { localContextArchives } from "../../benchmarks/evaluation/local-context-archives";
import type { ApiAgentEvent } from "../../src/domain/api-agent-event";
import { PRODUCT_HARNESS_VARIANT } from "../../src/domain/harness-variant";
import { WorkspaceId } from "../../src/domain/ids";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "../../src/domain/subagent";
import { agentTurnInstructions } from "../../src/server/services/agent-turn-instructions";
import { runModelAgent } from "../../src/server/services/model-agent-loop";
import { subagentTools } from "../../src/server/services/subagent-tools";
import { RehearsalVms } from "../../scripts/rehearsal/vm";
import type { TimedEvent } from "../harbor_v2/atif";
import { bedrockCredentials, bedrockWebSearchUsd } from "../harbor_v2/bedrock";
import { harborBridgeConfig } from "../harbor_v2/config";
import { type HarborWorkspace, harborHarness } from "../harbor_v2/harness";
import { harborRuntime } from "../harbor_v2/runtime";
import {
	estimatedUsd,
	guardedLanguageModel,
	reserveTrial,
	SpendCapReached,
	settleTrial,
	trialSpendGuard,
} from "../harbor_v2/spend";
import { harborTurnId, runsUsage } from "../harbor_v2/trial";

const IMAGE = "ytimesy-dprobe-vm:1";
const CWD = "/home/ubuntu/ytimesy";
const REQUEST_LIMIT = 12;

type Args = {
	arm: string;
	round: number;
	ids: number[];
	target: string;
	out: string;
	concurrency: number;
};

function parseArgs(argv: string[]): Args {
	const get = (name: string) => {
		const index = argv.indexOf(`--${name}`);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	const arm = get("arm");
	const target = get("target");
	const out = get("out");
	if (!arm || !target || !out)
		throw new Error("Pass --arm, --target and --out.");
	return {
		arm,
		round: Number(get("round") ?? 1),
		ids: (get("ids") ?? "1,2,3,4,5,6,7,8,9,10").split(",").map(Number),
		target,
		out,
		concurrency: Number(get("concurrency") ?? 3),
	};
}

type Delegation = {
	role: string;
	title: string;
	brief: string;
	wait?: boolean;
	/** Model requests made when the call ran (the step that asked for it). */
	request: number;
	/** Tool calls before it, in order. */
	toolCallsBefore: number;
};

type RunRecord = {
	arm: string;
	commit: string;
	round: number;
	id: number;
	text: string;
	label: string;
	delegated: boolean;
	delegations: Delegation[];
	outcome: "delegated" | "finished" | "request-limit" | "run-cap" | "error";
	error?: string;
	requests: number;
	usd: number;
	startedAt: string;
	seconds: number;
	toolCalls: { name: string; input: string }[];
	finalText?: string;
};

async function oneRun(
	args: Args,
	request: { id: number; text: string; label: string },
	commit: string,
	instructionsOut: { written: boolean },
): Promise<RunRecord> {
	const env = process.env;
	const config = harborBridgeConfig(env);
	const total = config.total;
	if (!total) throw new Error("A total cap and ledger are required.");
	const runCap = Number(env.YTIMESY_PROBE_RUN_USD_CAP ?? "1.5");
	// A short suffix: a rerun never collides with an earlier ledger entry.
	const runId = `${args.arm}-q${request.id}-r${args.round}-${randomUUID().slice(0, 6)}`;
	const started = Date.now();
	const record: RunRecord = {
		arm: args.arm,
		commit,
		round: args.round,
		id: request.id,
		text: request.text,
		label: request.label,
		delegated: false,
		delegations: [],
		outcome: "error",
		requests: 0,
		usd: 0,
		startedAt: new Date(started).toISOString(),
		seconds: 0,
		toolCalls: [],
	};
	try {
		await reserveTrial({
			ledger: total.ledger,
			totalCapUsd: total.capUsd,
			trial: runId,
			trialCapUsd: runCap,
		});
	} catch (error) {
		if (error instanceof SpendCapReached) {
			record.outcome = "run-cap";
			record.error = `not started: ${error.message}`;
			return record;
		}
		throw error;
	}
	const vms = new RehearsalVms(`dprobe-${runId}`);
	const vm = `dprobe-${runId}`;
	execFileSync("docker", ["rm", "-f", vm], { stdio: "ignore" });
	execFileSync("docker", [
		"run",
		"-d",
		"--name",
		vm,
		"--label",
		"ytimesy-dprobe=1",
		IMAGE,
		"sleep",
		"infinity",
	]);
	const events: TimedEvent[] = [];
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(40 * 60_000);
	const signal = AbortSignal.any([controller.signal, timeout]);
	const logsDir = join(args.out, "logs", runId);
	await mkdir(logsDir, { recursive: true });
	const sessionId = randomUUID();
	const archives = localContextArchives(
		`${logsDir}/context-archives`,
		"dprobe",
		sessionId,
	);
	const parts = () => [
		{ usage: runsUsage(events, [0]), billing: config.billing },
	];
	const guard = trialSpendGuard({
		capUsd: runCap,
		requestLimit: REQUEST_LIMIT,
		parts,
		extraUsd: () => bedrockWebSearchUsd(events.map((entry) => entry.event)),
	});
	const spent = () =>
		parts().reduce(
			(sum, part) => sum + estimatedUsd(part.usage, part.billing),
			bedrockWebSearchUsd(events.map((entry) => entry.event)),
		);
	try {
		execFileSync("docker", ["cp", `${args.target}/.`, `${vm}:${CWD}`]);
		execFileSync("docker", [
			"exec",
			"-u",
			"0",
			vm,
			"chown",
			"-R",
			"ubuntu:ubuntu",
			CWD,
		]);
		const machines = vms.machines();
		const workspace: HarborWorkspace = {
			machines,
			vm: WorkspaceId(vm),
			cwd: CWD,
			signal,
			sessionId,
			turnId: harborTurnId(sessionId),
		};
		// The product's delegation tools, with their real descriptions and
		// schemas; execute is replaced so no child ever starts.
		const real = subagentTools({
			machines,
			parent: {
				id: sessionId,
				userId: "dprobe",
				parentSessionId: null,
				agentRole: null,
				items: [],
			} as unknown as Parameters<typeof subagentTools>[0]["parent"],
			workspace: async () => workspace,
			signal,
		});
		let toolCallsSeen = 0;
		const stubs: ToolSet = {
			[AGENT_TOOL]: {
				...real[AGENT_TOOL],
				execute: async (input: {
					role: string;
					title: string;
					brief?: string;
					wait?: boolean;
				}) => {
					record.delegations.push({
						role: input.role,
						title: input.title,
						brief: input.brief ?? "",
						wait: input.wait,
						request: guard.requests(),
						toolCallsBefore: toolCallsSeen - 1,
					});
					record.delegated = true;
					// Let parallel agent calls of the same step record too.
					setTimeout(() => controller.abort("probe: first delegation"), 0);
					return { id: `1.${record.delegations.length}`, started: true };
				},
			} as ToolSet[string],
			[AGENT_SEND_TOOL]: {
				...real[AGENT_SEND_TOOL],
				execute: async () => ({ ok: true }),
			} as ToolSet[string],
		};
		const onEvent = async (event: ApiAgentEvent) => {
			events.push({ at: new Date().toISOString(), event });
			if (event.type === "tool-call") {
				toolCallsSeen++;
				record.toolCalls.push({
					name: event.name,
					input: JSON.stringify(event.input).slice(0, 300),
				});
			}
		};
		const runtime = await harborRuntime({
			config,
			env,
			userId: "dprobe",
			cacheScope: sessionId,
			// After the first delegation no further request is sent.
			wrapModel: (model) =>
				guardedLanguageModel(
					model,
					{
						...guard,
						beforeRequest: () => {
							if (record.delegated)
								throw new Error("probe: stopped at the first delegation");
							guard.beforeRequest();
						},
					},
					signal,
				),
		});
		const harness = await harborHarness({
			workspace,
			userId: "dprobe",
			modelId: config.modelId,
			provider: "openai",
			variant: PRODUCT_HARNESS_VARIANT,
			webSearch: config.webSearch,
			bedrock: true,
			instruction: request.text,
			storage: archives.storage,
			onEvent,
			extraTools: () => stubs,
		});
		// The product root builder's prompt (api-turn's turnInstructions
		// without cross-chat memory), not the bridge's unattended one.
		const instructions = agentTurnInstructions({
			session: {},
			tools: harness.tools,
			plugins: [],
			projectKnowledge: null,
			leanShape: harness.leanShape as Parameters<
				typeof agentTurnInstructions
			>[0]["leanShape"],
			leanReadOnly: false,
			leanWorkingDirectory: CWD,
			codeMode: undefined,
			prEvidence: false,
			lead: "off",
			leadTools: "full",
			rigor: false,
			forceDelegation: false,
		});
		if (!instructions.includes("Subagents: `agent` starts"))
			throw new Error("The orchestrator block is missing from the prompt.");
		if (!instructionsOut.written) {
			instructionsOut.written = true;
			await writeFile(
				join(args.out, `instructions-${args.arm}.txt`),
				`${instructions}\n\n--- tools ---\n${Object.keys(harness.tools).join("\n")}\n`,
			);
		}
		// Preflight (free): the bash tool works in this workspace.
		const bash = harness.tools.bash as {
			execute: (input: unknown, options: unknown) => Promise<unknown>;
		};
		const probe = JSON.stringify(
			await bash.execute(
				{ command: "pwd && git status --short | wc -l && node -v" },
				{ toolCallId: "probe-preflight", messages: [], abortSignal: signal },
			),
		);
		if (!probe.includes(CWD) || !probe.includes("v22"))
			throw new Error(`preflight: bash failed: ${probe.slice(0, 300)}`);
		// YTIMESY_PROBE_DRY=1: write the prompt and stop before any request.
		if (env.YTIMESY_PROBE_DRY === "1") throw new Error("dry run");
		const messages: ModelMessage[] = [{ role: "user", content: request.text }];
		let out: ModelMessage[] | null = null;
		try {
			out = await runModelAgent(
				{
					userId: "dprobe",
					modelId: config.modelId,
					reasoning: config.effort,
					toolSurface: "implementation",
					cacheScopeId: sessionId,
					...harness.input,
					tools: harness.tools,
					instructions,
					signal,
					maxSteps: REQUEST_LIMIT,
					turnTimeoutMs: 40 * 60_000,
					messages,
					onEvent,
					onStep: async () => {},
				},
				runtime,
			);
		} catch (error) {
			if (!record.delegated) {
				const stop = guard.stopReason();
				record.outcome = stop?.includes("request limit")
					? "request-limit"
					: stop
						? "run-cap"
						: "error";
				record.error = stop ?? String((error as Error)?.message ?? error);
			}
		}
		if (record.delegated) record.outcome = "delegated";
		else if (out) {
			record.outcome =
				guard.requests() >= REQUEST_LIMIT ? "request-limit" : "finished";
			const last = [...out].reverse().find((m) => m.role === "assistant");
			record.finalText =
				typeof last?.content === "string"
					? last.content.slice(0, 1500)
					: JSON.stringify(last?.content ?? "").slice(0, 1500);
		}
	} catch (error) {
		record.outcome = record.delegated ? "delegated" : "error";
		record.error = String((error as Error)?.message ?? error).slice(0, 500);
	} finally {
		record.requests = guard.requests();
		record.usd = Number(spent().toFixed(4));
		record.seconds = Math.round((Date.now() - started) / 1000);
		await settleTrial({
			ledger: total.ledger,
			trial: runId,
			usd: record.usd,
			totalCapUsd: total.capUsd,
		}).catch(() => {});
		await archives.close().catch(() => {});
		await writeFile(
			join(logsDir, "events.json"),
			JSON.stringify(events, null, 1),
		).catch(() => {});
		execFileSync("docker", ["rm", "-f", vm], { stdio: "ignore" });
	}
	return record;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	await bedrockCredentials(process.env);
	const list = JSON.parse(
		await readFile(new URL("./requests.json", import.meta.url), "utf8"),
	) as { requests: { id: number; text: string; label: string }[] };
	const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
		encoding: "utf8",
	}).trim();
	await mkdir(args.out, { recursive: true });
	const queue = list.requests.filter((r) => args.ids.includes(r.id));
	const instructionsOut = { written: false };
	const resultsFile = join(args.out, `results-${args.arm}.jsonl`);
	const worker = async () => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			const record = await oneRun(args, next, commit, instructionsOut);
			const { toolCalls: _calls, ...brief } = record;
			console.log(
				JSON.stringify({
					...brief,
					delegations: record.delegations.map((d) => ({
						role: d.role,
						title: d.title,
						request: d.request,
					})),
					finalText: undefined,
				}),
			);
			await writeFile(resultsFile, `${JSON.stringify(record)}\n`, {
				flag: "a",
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.max(1, args.concurrency) }, worker),
	);
}

await main();
process.exit(0);
