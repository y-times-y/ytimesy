import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { localContextArchives } from "../benchmarks/evaluation/local-context-archives";
import { harborBridgeConfig } from "../evals/harbor_v2/config";
import {
	ENV_SNAPSHOT_HEADER,
	ENV_SNAPSHOT_MAX_CHARS,
	envSnapshot,
	envSnapshotProbe,
} from "../evals/harbor_v2/env-snapshot";
import { grindMinimumMs, grindNotice } from "../evals/harbor_v2/grind-gate";
import {
	HARBOR_REQUEST,
	harborChannel,
	harborMachines,
} from "../evals/harbor_v2/harbor-machines";
import {
	type LedgerState,
	REQUIREMENTS_TOOL,
	requirementsTool,
} from "../evals/harbor_v2/requirement-ledger";
import { briefFindingsPath, ranTranscript } from "../evals/harbor_v2/review";
import { ledgerSummary } from "../evals/harbor_v2/spend";
import { harborTurnId, runHarborTrial } from "../evals/harbor_v2/trial";
import { WorkspaceId } from "../src/domain/ids";
import { modelBilling, usageCostUsd } from "../src/domain/model-pricing";
import { agentOutputDirectory } from "../src/server/services/agent-output-artifacts";
import {
	COMMAND_TMUX_SOCKET,
	commandRoot,
	commandSessionName,
} from "../src/server/services/api-agent-command-tools";
import { commandScopeRoot } from "../src/server/services/api-command-scope";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";
import { localHarnessWorkspace } from "./helpers/local-harness-workspace";

/**
 * One whole bridge v2 trial offline: the real harness (lean tools, product
 * prompt, repository context, model loop) against a mock model, every
 * command going through the Harbor wire protocol to a local git checkout
 * that stands in for the task container.
 */

type Part = Record<string, unknown>;
const usage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: output, text: output, reasoning: 0 },
});
const finish = (input: number, output: number, tools = false) => ({
	type: "finish",
	usage: usage(input, output),
	finishReason: tools
		? { unified: "tool-calls", raw: "tool_calls" }
		: { unified: "stop", raw: "stop" },
});
const text = (id: string, value: string): Part[] => [
	{ type: "text-start", id },
	{ type: "text-delta", id, delta: value },
	{ type: "text-end", id },
];
const call = (id: string, name: string, input: unknown): Part => ({
	type: "tool-call",
	toolCallId: id,
	toolName: name,
	input: JSON.stringify(input),
});

/** A checker step that runs a command: its verdict is matched against what it ran. */
const ran = (id: string, command = "python3 solution.py"): Part[] => [
	call(id, "bash", { command }),
	finish(0, 0, true),
];

function scriptedModel(responses: Part[][]) {
	let index = 0;
	const model = new MockLanguageModelV4({
		provider: "anthropic.messages",
		modelId: "claude-opus-5-5",
		doStream: async () => ({
			stream: simulateReadableStream({
				chunks: responses[Math.min(index++, responses.length - 1)] as never[],
				initialDelayInMs: null,
				chunkDelayInMs: null,
			}),
		}),
	});
	return { model, calls: () => index };
}

/** The Python agent's side: answers each exec request by running it in the checkout. */
function pythonSide(
	workspace: Awaited<ReturnType<typeof localHarnessWorkspace>>["workspace"],
) {
	const toBridge = new PassThrough();
	const fromBridge = new PassThrough();
	let buffer = "";
	const commands: string[] = [];
	fromBridge.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		for (
			let index = buffer.indexOf("\n");
			index >= 0;
			index = buffer.indexOf("\n")
		) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (!line.startsWith(HARBOR_REQUEST)) continue;
			const request = JSON.parse(line.slice(HARBOR_REQUEST.length));
			if (request.op !== "exec") continue;
			commands.push(request.command);
			void workspace.machines
				.exec(workspace.vm, request.command, request.timeoutMs)
				.then((result) =>
					toBridge.write(`${JSON.stringify({ id: request.id, ...result })}\n`),
				);
		}
	});
	const channel = harborChannel({ stdin: toBridge, stdout: fromBridge });
	return { machines: harborMachines(channel.exec), commands };
}

const env = (extra: Record<string, string> = {}) => ({
	YTIMESY_HARBOR_ROUTE: "anthropic",
	YTIMESY_HARBOR_APPROVED: "anthropic",
	YTIMESY_HARBOR_WEB_SEARCH: "off",
	...extra,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(extraEnv: Record<string, string> = {}) {
	const checkout = await localHarnessWorkspace();
	const logs = await mkdtemp(join(tmpdir(), "harbor-v2-logs-"));
	cleanups.push(checkout.cleanup, () =>
		rm(logs, { recursive: true, force: true }),
	);
	const ledger = join(logs, "ledger.jsonl");
	const config = harborBridgeConfig(
		env({
			YTIMESY_HARBOR_TOTAL_USD_CAP: "10",
			YTIMESY_HARBOR_SPEND_LEDGER: ledger,
			YTIMESY_HARBOR_TRIAL_USD_CAP: "2",
			...extraEnv,
		}),
	);
	const side = pythonSide(checkout.workspace);
	const archives = localContextArchives(
		join(logs, "archives"),
		"harbor",
		"trial-1",
	);
	cleanups.push(() => archives.close());
	return { checkout, logs, ledger, config, side, archives };
}

describe("runHarborTrial", () => {
	it("runs the lean harness through the Harbor protocol and writes ATIF, trace and spend", async () => {
		const f = await fixture();
		const { model, calls } = scriptedModel([
			[
				...text("t1", "Writing the solution."),
				call("c1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(1000, 50, true),
			],
			[
				call("c2", "bash", { command: "python3 solution.py" }),
				finish(1200, 30, true),
			],
			[...text("t2", "Done: solution.py prints 42."), finish(1300, 20)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-1",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 120_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect(calls()).toBe(3);
		expect(result.requests).toBe(3);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		// Every command reached the "container" through the Harbor protocol.
		expect(f.side.commands.length).toBeGreaterThan(3);
		// 3500 input x $4/M + 100 output x $20/M
		expect(result.costUsd).toBeCloseTo(0.014 + 0.002, 6);

		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		expect(trajectory.schema_version).toBe("ATIF-v1.7");
		expect(
			trajectory.steps.map((step: { source: string }) => step.source),
		).toEqual(["system", "user", "agent", "agent", "agent"]);
		expect(trajectory.steps[0].message).toContain(
			"You are the ytimesy coding agent",
		);
		expect(trajectory.steps[2].tool_calls[0]).toMatchObject({
			tool_call_id: "c1",
			function_name: "write",
			arguments: { path: "solution.py" },
		});
		expect(trajectory.steps[2].observation.results[0].source_call_id).toBe(
			"c1",
		);
		// The command ran through the product's runner (its exit status is
		// Linux-specific; the runner itself is covered by its own tests).
		expect(trajectory.steps[3].observation.results[0]).toMatchObject({
			source_call_id: "c2",
			content: expect.stringContaining('"command":"python3 solution.py"'),
		});
		expect(trajectory.steps[4].message).toBe("Done: solution.py prints 42.");
		expect(trajectory.steps[2].metrics).toMatchObject({
			prompt_tokens: 1000,
			completion_tokens: 50,
		});
		expect(trajectory.final_metrics).toMatchObject({
			total_prompt_tokens: 3500,
			total_completion_tokens: 100,
			total_steps: 5,
		});
		expect(trajectory.agent.extra).toMatchObject({
			route: "anthropic",
			model: "claude-opus-5-5",
			variant: "default",
		});
		const tools = trajectory.agent.tool_definitions.map(
			(entry: { function: { name: string } }) => entry.function.name,
		);
		expect(tools).toEqual(
			expect.arrayContaining(["read", "write", "edit", "bash"]),
		);

		// With Harbor installed (HARBOR_PYTHON=<its python>), Harbor's own ATIF
		// model validates the file and derives the trial's model usage from it.
		if (process.env.HARBOR_PYTHON) {
			const checked = await promisify(execFile)(process.env.HARBOR_PYTHON, [
				"-I",
				"-c",
				"import sys,json;from pathlib import Path;from harbor.models.trajectories import Trajectory;from harbor.utils.trajectory_utils import load_model_usage_from_trajectory;Trajectory.model_validate_json(Path(sys.argv[1]).read_text());u=load_model_usage_from_trajectory(Path(sys.argv[1]));print(json.dumps({k:v.model_dump() for k,v in (u or {}).items()}))",
				join(f.logs, "trajectory.json"),
			]);
			expect(JSON.parse(checked.stdout)).toHaveProperty("claude-opus-5-5");
		}
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		expect(trace).toMatchObject({
			trial: "trial-1",
			requests: 3,
			failure: null,
		});
		const ledger = await ledgerSummary(f.ledger);
		expect(ledger.entries).toBe(2);
		expect(ledger.committedUsd).toBeCloseTo(0.016, 6);
	}, 60_000);

	it("stops at the trial cap before the next request and settles what was spent", async () => {
		const f = await fixture({ YTIMESY_HARBOR_TRIAL_USD_CAP: "0.01" });
		const { model, calls } = scriptedModel([
			[call("c1", "bash", { command: "true" }), finish(2000, 100, true)],
			[...text("t", "never sent"), finish(1, 1)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-cap",
			instruction: "Anything.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		// $0.008 + $0.002 = $0.010 reached the $0.01 cap: the second request never started.
		expect(calls()).toBe(1);
		expect(result.failure).toMatch(/spending cap reached/i);
		expect(result.costUsd).toBeCloseTo(0.01, 6);
		expect((await ledgerSummary(f.ledger)).committedUsd).toBeCloseTo(0.01, 6);
	}, 60_000);

	it("refuses before any inference when the total cap has no room, and never overwrites a trace", async () => {
		const f = await fixture();
		await writeFile(
			f.ledger,
			`${JSON.stringify({ type: "settle", trial: "earlier", usd: 9, at: "2026-10-18T00:00:00Z" })}\n`,
		);
		const { model, calls } = scriptedModel([[...text("t", "x"), finish(1, 1)]]);
		const run = (trialId: string) =>
			runHarborTrial({
				config: f.config,
				trialId,
				instruction: "Anything.",
				cwd: f.checkout.root,
				logsDir: f.logs,
				deadlineAt: Date.now() + 60_000,
				machines: f.side.machines,
				userId: "harbor",
				storage: f.archives.storage,
				runtime: async (wrap) => ({ model: wrap(model) }),
				harness: {
					name: "ytimesy",
					version: "test",
					commit: null,
					bundleSha256: null,
				},
			});
		const refused = await run("trial-over");
		expect(refused.refused).toMatch(/Total spending cap/);
		expect(calls()).toBe(0);
		await writeFile(join(f.logs, "ytimesy-trace.json"), "{}");
		await expect(run("trial-again")).rejects.toThrow(/already exists/);
	}, 60_000);
});

describe("runHarborTrial with review=on", () => {
	it("runs the product's review loop in process: checker findings go back to the builder, checker works in its own copy", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		const failing = JSON.stringify({
			verdict: "fail",
			failures: [
				{
					failure: "Output: solution.py prints 41, the request asks for 42",
					command: "python3 solution.py",
					output: "41",
				},
			],
			requirements: [
				{
					requirement: "prints 42",
					met: false,
					command: "python3 solution.py",
					output: "41",
				},
			],
			assumptions: [],
			notes: "",
		});
		const passing = JSON.stringify({
			verdict: "pass",
			failures: [],
			requirements: [
				{
					requirement: "prints 42",
					met: true,
					command: "python3 solution.py",
					output: "42",
				},
			],
			tests: [
				{ name: "prints 42", command: "python3 solution.py", passed: true },
			],
			assumptions: [],
			notes: "",
		});
		const { model, calls } = scriptedModel([
			// Builder, attempt 1.
			[
				call("b1", "write", { path: "solution.py", content: "print(41)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
			// Checker, round 1: a stray file from a command (a reader has no
			// write tool but runs commands), then its verdict.
			[
				call("k1", "bash", {
					command: "echo checker scratch > stray.txt; python3 solution.py",
				}),
				finish(100, 10, true),
			],
			[...text("k2", failing), finish(100, 10)],
			// Builder fixes after the findings notice.
			[
				call("b3", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b4", "Fixed: prints 42."), finish(100, 10)],
			// Checker, round 2.
			ran("k3-run"),
			[...text("k3", passing), finish(100, 10)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-review",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect(calls()).toBe(8);
		expect(result.reviewRounds).toBe(1);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		await expect(
			readFile(join(f.checkout.root, "stray.txt")),
		).rejects.toThrow();
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		expect(trace.review.checks).toHaveLength(2);
		// The checker worked in its own copy: its stray file never reached the checkout.
		expect(trace.review.readerCopies[0]).toMatchObject({
			sessionId: "harbor-checker-1",
			ok: true,
		});
		expect(trace.review.summary).toBeTruthy();
		// Its finding cites a command it ran (k1), so none was set aside.
		expect(trace.review.state.rounds[0].verdict.downgraded).toEqual([]);
		expect(trace.review.state.rounds[0].findings[0].text).toContain(
			"(ran `python3 solution.py` -> 41)",
		);
		// Builder and checkers count against one trial: 8 requests, 700 + 70 tokens.
		expect(result.requests).toBe(8);
		expect(result.usage).toMatchObject({ inputTokens: 700, outputTokens: 70 });
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		const notice = trajectory.steps.find(
			(step: { extra?: { kind?: string } }) =>
				step.extra?.kind === "runtime-notice",
		);
		expect(notice.source).toBe("user");
		expect(notice.message).toContain("prints 41");
		// The fix is a second builder run: its usage adds to the first's.
		expect(trajectory.final_metrics.total_prompt_tokens).toBe(400);
		expect(trajectory.subagent_trajectories).toHaveLength(2);
		expect(trajectory.subagent_trajectories[0].trajectory_id).toBe(
			"harbor-checker-1",
		);
		expect(trajectory.subagent_trajectories[0].steps[0].message).toContain(
			"checker",
		);
		if (process.env.HARBOR_PYTHON)
			await promisify(execFile)(process.env.HARBOR_PYTHON, [
				"-I",
				"-c",
				"import sys;from pathlib import Path;from harbor.models.trajectories import Trajectory;Trajectory.model_validate_json(Path(sys.argv[1]).read_text())",
				join(f.logs, "trajectory.json"),
			]);
	}, 120_000);
	it("passes codeMode=primary and roleModels.checker through: the checker runs on its own model, as a reader, priced at its route", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"review=on,codeMode=primary,roleModels.checker=claude-sonnet-5-5",
		});
		const passing = JSON.stringify({
			verdict: "pass",
			failures: [],
			requirements: [
				{
					requirement: "prints 42",
					met: true,
					command: "python3 solution.py",
					output: "42",
				},
			],
			tests: [
				{ name: "prints 42", command: "python3 solution.py", passed: true },
			],
			assumptions: [],
			notes: "",
		});
		const builder = scriptedModel([
			[
				call("b1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
		]);
		const checker = scriptedModel([
			ran("k0"),
			[...text("k1", passing), finish(1000, 100)],
		]);
		const runtimes: (string | null)[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-roles",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap, model) => {
				runtimes.push(model?.modelId ?? null);
				return { model: wrap(model ? checker.model : builder.model) };
			},
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect(runtimes).toEqual([null, "claude-sonnet-5-5"]);
		expect(builder.calls()).toBe(2);
		expect(checker.calls()).toBe(2);
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		// primary: run_code first, the command tool says what it is still for.
		const builderTools = trajectory.agent.tool_definitions.map(
			(entry: { function: { name: string } }) => entry.function.name,
		);
		expect(builderTools[0]).toBe("run_code");
		expect(trajectory.steps[0].message).toContain("run_code is your main tool");
		// The checker: its own model, a reader surface (commands, no write or
		// edit), and no orchestration block (the bridge has no agent tool).
		const sub = trajectory.subagent_trajectories[0];
		expect(sub.agent.model_name).toBe("claude-sonnet-5-5");
		expect(sub.steps[0].message).toContain("checker");
		expect(sub.steps[0].message).not.toContain("Subagents:");
		const checkerTools = sub.agent.tool_definitions.map(
			(entry: { function: { name: string } }) => entry.function.name,
		);
		expect(checkerTools).toEqual(
			expect.arrayContaining(["run_code", "read", "bash"]),
		);
		expect(checkerTools).not.toContain("write");
		expect(checkerTools).not.toContain("edit");
		expect(trajectory.steps[0].message).not.toContain("Subagents:");
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		expect(trace.checkerModel).toMatchObject({ model: "claude-sonnet-5-5" });
		expect(trace.checkers[0].model).toBe("claude-sonnet-5-5");
		// The product's loop state records it, so its own spend uses that price.
		expect(trace.review.state.rounds[0].checker.model).toMatchObject({
			harness: "api",
			modelId: "claude-sonnet-5-5",
		});
		// Each run at its own price.
		const opus = modelBilling({ harness: "api", modelId: "claude-opus-5-5" });
		const sonnet = modelBilling({
			harness: "api",
			modelId: "claude-sonnet-5-5",
		});
		const tokens = (input: number, output: number) => ({
			inputTokens: input,
			outputTokens: output,
			uncachedInputTokens: input,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		const expected =
			(usageCostUsd(tokens(200, 20), opus) ?? 0) +
			(usageCostUsd(tokens(1000, 100), sonnet) ?? 0);
		expect(result.costUsd).toBeCloseTo(expected, 8);
		// The shared AA-style block: per role and model, calls and cache hit.
		expect(result.efficiency).toMatchObject({
			tasks: 1,
			callsPerTask: 4,
			tokensPerTask: 1320,
			cacheHitRate: 0,
		});
		expect(result.efficiency?.perTaskUsd).toBeCloseTo(expected, 8);
		expect(
			result.efficiency?.models.map((row) => [
				row.role,
				row.model,
				row.requests,
			]),
		).toEqual([
			["builder", "claude-opus-5-5", 2],
			["checker", "claude-sonnet-5-5", 2],
		]);
		expect(trace.efficiency.perTaskUsd).toBeCloseTo(expected, 8);
		expect(trajectory.final_metrics.extra.efficiency.callsPerTask).toBe(4);
		expect(trajectory.final_metrics.total_cost_usd).toBeCloseTo(expected, 6);
		// Harbor attributes each embedded checker trajectory to its own model.
		if (process.env.HARBOR_PYTHON) {
			const checked = await promisify(execFile)(process.env.HARBOR_PYTHON, [
				"-I",
				"-c",
				"import sys,json;from pathlib import Path;from harbor.utils.trajectory_utils import load_model_usage_from_trajectory;u=load_model_usage_from_trajectory(Path(sys.argv[1]));print(json.dumps({k:v.model_dump() for k,v in (u or {}).items()}))",
				join(f.logs, "trajectory.json"),
			]);
			const byModel = JSON.parse(checked.stdout);
			expect(byModel["claude-opus-5-5"]).toMatchObject({ n_input_tokens: 200 });
			expect(byModel["claude-sonnet-5-5"]).toMatchObject({
				n_input_tokens: 1000,
			});
		}
	}, 120_000);
	it("runs lead=fusion: exploration, a sidekick build in the checkout, a classifier decision, the lead's answer; costs per role", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,rigor=on,roleModels.writer=claude-sonnet-5-5,roleModels.classifier=claude-haiku-5-5@low",
		});
		const onTrack = JSON.stringify({ decision: "on_track", reason: "fine" });
		const lead = scriptedModel([
			[
				call("l1", "agent_send", {
					id: "trial-fusion.1",
					message: "Create solution.py that prints 42; run it.",
				}),
				finish(100, 10, true),
			],
			[...text("l2", "Done: solution.py prints 42."), finish(100, 10)],
		]);
		const sidekick = scriptedModel([
			[...text("s1", "Explored: no solution.py yet."), finish(50, 5)],
			// Round 2 runs a command after round 1's end stopped round 1's commands.
			[
				call("s2b", "bash", { command: "echo round-$((1 + 1))" }),
				finish(50, 5, true),
			],
			[
				call("s2", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(50, 5, true),
			],
			[
				...text("s3", "Wrote solution.py; python3 solution.py -> 42"),
				finish(50, 5),
			],
		]);
		const classifier = scriptedModel([[...text("c1", onTrack), finish(20, 2)]]);
		// Command scopes outlive a run on this machine: start the rounds' afresh.
		for (const round of [1, 2, 3])
			await rm(commandScopeRoot(harborTurnId("trial-fusion.1", round)), {
				recursive: true,
				force: true,
			});
		const runtimes: (string | null)[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-fusion",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap, model) => {
				runtimes.push(model?.modelId ?? null);
				return {
					model: wrap(
						model?.modelId === "claude-sonnet-5-5"
							? sidekick.model
							: model?.modelId === "claude-haiku-5-5"
								? classifier.model
								: lead.model,
					),
				};
			},
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect([lead.calls(), sidekick.calls(), classifier.calls()]).toEqual([
			2, 4, 2,
		]);
		// The sidekick wrote the lead's own checkout.
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		expect(trace.fusion.rounds.map((r: { kind: string }) => r.kind)).toEqual([
			"explore",
			"build",
		]);
		// Each round has its own command scope: round 2's command ran, not exit 130.
		const sidekickEvents = trace.checkers.find(
			(child: { sessionId: string }) => child.sessionId === "trial-fusion.1",
		).events;
		const bash = sidekickEvents.find(
			(entry: { event: { type: string; name?: string } }) =>
				entry.event.type === "tool-result" && entry.event.name === "bash",
		).event;
		expect(JSON.stringify(bash.output)).toContain("round-2");
		expect(bash.output.status).not.toBe(130);
		expect(trace.fusion.decisions).toHaveLength(2);
		expect(trace.fusion.decisions[1]).toMatchObject({
			decision: "on_track",
			source: "classifier",
			model: "claude-haiku-5-5",
			tokens: 22,
		});
		expect(trace.fusion.decisions[1].costUsd).toBeGreaterThan(0);
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		// The sidekick gets the product's sidekick block (model-facing text says
		// "Main's writer"): publishing stays the lead's.
		const sidekickPrompt = trajectory.subagent_trajectories.find(
			(entry: { trajectory_id: string }) =>
				entry.trajectory_id === "trial-fusion.1",
		).steps[0].message;
		expect(sidekickPrompt).toContain("You are Main's writer");
		expect(sidekickPrompt).toContain("do not commit, stash, reset");
		// The lead's prompt is the product's fusion lead block ("you are Main"), with the rigor block.
		expect(trajectory.steps[0].message).toContain("you are Main");
		expect(
			trajectory.agent.tool_definitions.map(
				(entry: { function: { name: string } }) => entry.function.name,
			),
		).toEqual(expect.arrayContaining(["agent", "agent_send"]));
		expect(
			result.efficiency?.models.map((row) => [
				row.role,
				row.model,
				row.requests,
			]),
		).toEqual([
			["builder", "claude-opus-5-5", 2],
			["sidekick", "claude-sonnet-5-5", 4],
			["classifier", "claude-haiku-5-5", 2],
		]);
	}, 120_000);

	it("runs review=on with checkerMode=pair: the judge briefs a read-only worker, its findings reach the builder, costs per role", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"review=on,checkerMode=pair,roleModels.checker=claude-sonnet-5-5,roleModels.checkerWorker=claude-haiku-5-5",
		});
		const verdict = (pass: boolean) =>
			JSON.stringify({
				verdict: pass ? "pass" : "fail",
				failures: pass
					? []
					: [
							{
								failure:
									"Output: solution.py prints 41, the request asks for 42",
								command: "python3 solution.py",
								output: "41",
							},
						],
				requirements: [
					{
						requirement: "prints 42",
						met: pass,
						command: "python3 solution.py",
						output: pass ? "42" : "41",
					},
				],
				tests: [
					{
						name: "prints 42",
						passed: pass,
						command: "python3 solution.py > worker-out.txt; cat worker-out.txt",
					},
				],
				assumptions: [],
				notes: "",
			});
		const builder = scriptedModel([
			[
				call("b1", "write", { path: "solution.py", content: "print(41)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
			[
				call("b3", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b4", "Fixed."), finish(100, 10)],
		]);
		const judge = scriptedModel([
			[
				call("j1", "checker_worker", {
					brief: "Run python3 solution.py and report its output.",
				}),
				finish(200, 20, true),
			],
			[...text("j2", verdict(false)), finish(200, 20)],
			// Round 2: the judge re-runs the worker's test itself.
			ran("j3-run", "python3 solution.py > worker-out.txt; cat worker-out.txt"),
			[...text("j3", verdict(true)), finish(200, 20)],
		]);
		const worker = scriptedModel([
			[
				call("w1", "bash", {
					command: "python3 solution.py > worker-out.txt; cat worker-out.txt",
				}),
				finish(30, 3, true),
			],
			[...text("w2", "python3 solution.py exit 0, prints 41"), finish(30, 3)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-pair",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap, model) => ({
				model: wrap(
					model?.modelId === "claude-sonnet-5-5"
						? judge.model
						: model?.modelId === "claude-haiku-5-5"
							? worker.model
							: builder.model,
				),
			}),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect([builder.calls(), judge.calls(), worker.calls()]).toEqual([4, 4, 2]);
		expect(result.reviewRounds).toBe(1);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		// The worker wrote only in the judge's copy.
		await expect(
			readFile(join(f.checkout.root, "worker-out.txt")),
		).rejects.toThrow();
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		const round = trace.review.state.rounds[0];
		expect(round.checker.pair).toBe(true);
		expect(round.checker.workers[0]).toMatchObject({
			sessionId: "harbor-checker-1.1",
		});
		expect(round.findings[0].text).toContain("prints 41");
		// The worker's commands reach the verdict: its test is marked as the worker's.
		expect(round.verdict.tests[0].ranBy).toBe("worker");
		expect(
			result.efficiency?.models.map((row) => [
				row.role,
				row.model,
				row.requests,
			]),
		).toEqual([
			["builder", "claude-opus-5-5", 4],
			["checker", "claude-sonnet-5-5", 4],
			["checkerWorker", "claude-haiku-5-5", 2],
		]);
	}, 120_000);
});

/**
 * Rehearsal of the tb4 harness fixes: each case one whole trial against
 * scripted models, through the Harbor wire protocol to a local checkout.
 */
describe("runHarborTrial rehearsal: unattended review and child budgets", () => {
	const verdict = (pass: boolean) =>
		JSON.stringify({
			verdict: pass ? "pass" : "fail",
			failures: pass ? [] : ["solution.py is missing"],
			requirements: [
				{
					requirement: "prints 42",
					met: pass,
					evidence: pass ? "python3 solution.py -> 42" : "no solution.py",
				},
			],
			tests: [
				{
					name: "prints 42",
					command: "python3 solution.py",
					passed: pass,
					probe: false,
					output: pass ? "42" : "No such file",
				},
			],
			assumptions: [],
			notes: "",
		});
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const trace = async (logs: string) =>
		JSON.parse(await readFile(join(logs, "ytimesy-trace.json"), "utf8"));
	const notices = async (logs: string) =>
		JSON.parse(
			await readFile(join(logs, "trajectory.json"), "utf8"),
		).steps.filter(
			(step: { extra?: { kind?: string } }) =>
				step.extra?.kind === "runtime-notice",
		);
	async function trial(
		f: Awaited<ReturnType<typeof fixture>>,
		trialId: string,
		runtime: Parameters<typeof runHarborTrial>[0]["runtime"],
		extra: { deadlineAt?: number; now?: () => number; restore?: string } = {},
	) {
		for (const round of [1, 2, 3])
			await rm(commandScopeRoot(harborTurnId(`${trialId}.1`, round)), {
				recursive: true,
				force: true,
			});
		return runHarborTrial({
			config: f.config,
			trialId,
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: extra.deadlineAt ?? Date.now() + 3 * 60 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime,
			harness,
			...(extra.now ? { now: extra.now } : {}),
			...(extra.restore ? { restore: extra.restore } : {}),
		});
	}

	it("checker-only: unpacks a saved workspace after the baseline and reviews it once, with no builder run", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		const saved = await mkdtemp(join(tmpdir(), "harbor-restore-"));
		await writeFile(join(saved, "solution.py"), "print(42)\n");
		const archive = `${saved}.tar`;
		execFileSync("tar", ["-cf", archive, "-C", saved, "solution.py"]);
		const { model, calls } = scriptedModel([
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
		]);
		const result = await trial(
			f,
			"rh-restore",
			async (wrap) => ({ model: wrap(model) }),
			{ restore: archive },
		);
		expect(result.failure).toBeNull();
		expect(calls()).toBe(2);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		const t = await trace(f.logs);
		expect(t.review.checks).toHaveLength(1);
		expect(t.review.state.rounds[0].changedFiles).toBe(1);
		expect(t.review.state.outcome).toBe("pass");
	}, 120_000);

	it("refuses checker-only without review=on", async () => {
		const f = await fixture({});
		await expect(
			trial(
				f,
				"rh-restore-off",
				async (wrap) => ({ model: wrap({} as never) }),
				{ restore: "/tmp/none.tar" },
			),
		).rejects.toThrow(/needs review=on/);
	});

	it("lead + sidekick + checker: the sidekick builds, the lead answers, the checker reviews the lead's turn", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,review=on,roleModels.writer=claude-sonnet-5-5,roleModels.classifier=claude-haiku-5-5@low",
		});
		// The checker runs on the lead's model: its verdict follows the lead's answer.
		const lead = scriptedModel([
			[
				call("l1", "agent_send", {
					id: "rh-fusion.1",
					message: "Create solution.py that prints 42; run it.",
				}),
				finish(100, 10, true),
			],
			[...text("l2", "Done: solution.py prints 42."), finish(100, 10)],
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
		]);
		const sidekick = scriptedModel([
			[...text("s1", "Explored: no solution.py yet."), finish(50, 5)],
			[
				call("s2", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(50, 5, true),
			],
			[...text("s3", "Wrote solution.py; prints 42"), finish(50, 5)],
		]);
		const classifier = scriptedModel([
			[
				...text("c1", JSON.stringify({ decision: "on_track", reason: "ok" })),
				finish(20, 2),
			],
		]);
		const result = await trial(f, "rh-fusion", async (wrap, model) => ({
			model: wrap(
				model?.modelId === "claude-sonnet-5-5"
					? sidekick.model
					: model?.modelId === "claude-haiku-5-5"
						? classifier.model
						: lead.model,
			),
		}));
		expect(result.failure).toBeNull();
		expect([lead.calls(), sidekick.calls()]).toEqual([4, 3]);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		const t = await trace(f.logs);
		expect(t.fusion.rounds.map((r: { kind: string }) => r.kind)).toEqual([
			"explore",
			"build",
		]);
		expect(t.review.checks).toHaveLength(1);
		expect(t.review.state.outcome).toBe("pass");
		expect(result.efficiency?.models.map((row) => row.role)).toEqual(
			expect.arrayContaining(["builder", "sidekick", "classifier", "checker"]),
		);
	}, 120_000);

	it("thin lead (the default for lead=fusion): the lead only delegates and inspects, the sidekick builds, the checker reviews", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,review=on,roleModels.writer=claude-sonnet-5-5,roleModels.classifier=claude-haiku-5-5@low",
		});
		const lead = scriptedModel([
			// It tries to run the deliverable itself: refused, it is told to brief.
			[
				call("l0", "bash", { command: "python3 solution.py" }),
				finish(100, 10, true),
			],
			[
				call("l1", "agent_send", {
					id: "rh-thin.1",
					message:
						"Goal: solution.py prints 42. Acceptance: python3 solution.py prints 42; paste the output.",
				}),
				finish(100, 10, true),
			],
			// Review: a bounded inspection of the round's changes.
			[
				call("l2", "bash", { command: "git status --short" }),
				finish(100, 10, true),
			],
			[
				...text("l3", "Done: solution.py prints 42 (writer ran it)."),
				finish(100, 10),
			],
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
		]);
		const sidekick = scriptedModel([
			[...text("s1", "Explored: no solution.py yet."), finish(50, 5)],
			[
				call("s2", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(50, 5, true),
			],
			[
				call("s3", "bash", { command: "python3 solution.py" }),
				finish(50, 5, true),
			],
			[
				...text("s4", "Wrote solution.py. python3 solution.py -> 42 (exit 0)"),
				finish(50, 5),
			],
		]);
		const classifier = scriptedModel([
			[
				...text("c1", JSON.stringify({ decision: "on_track", reason: "ok" })),
				finish(20, 2),
			],
		]);
		const result = await trial(f, "rh-thin", async (wrap, model) => ({
			model: wrap(
				model?.modelId === "claude-sonnet-5-5"
					? sidekick.model
					: model?.modelId === "claude-haiku-5-5"
						? classifier.model
						: lead.model,
			),
		}));
		expect(result.failure).toBeNull();
		expect([lead.calls(), sidekick.calls()]).toEqual([6, 4]);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		const t = await trace(f.logs);
		// The lead's effort is held at leadEffort=high; the bridge default is max.
		expect([t.effort, t.leadEffort]).toEqual(["max", "high"]);
		expect(t.fusion.rounds.map((r: { kind: string }) => r.kind)).toEqual([
			"explore",
			"build",
		]);
		const leadEvents = JSON.stringify(t.events);
		expect(leadEvents).toContain("`python3` is not an inspection command");
		// The lead never wrote: every file change is the sidekick's.
		const sidekickEvents = JSON.stringify(
			t.checkers.find((c: { sessionId: string }) => c.sessionId === "rh-thin.1")
				.events,
		);
		expect(sidekickEvents).toContain("solution.py");
		expect(leadEvents).not.toMatch(/"name":"(write|edit)"/);
		// The checker ran after the lead's answer and passed it.
		expect(t.review.checks).toHaveLength(1);
		expect(t.review.state.outcome).toBe("pass");
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		const leadTools = trajectory.agent.tool_definitions.map(
			(entry: { function: { name: string } }) => entry.function.name,
		);
		expect(leadTools.sort()).toEqual(["agent", "agent_send", "bash", "read"]);
		expect(trajectory.steps[0].message).toContain(
			"You decide; your writer does.",
		);
	}, 120_000);

	it("leadTools=full restores the earlier lead: the whole builder surface beside the agent tools", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,leadTools=full,leadEffort=inherit,roleModels.writer=claude-sonnet-5-5,roleModels.classifier=claude-haiku-5-5@low",
		});
		const lead = scriptedModel([[...text("l1", "Done."), finish(100, 10)]]);
		const sidekick = scriptedModel([
			[...text("s1", "Explored."), finish(50, 5)],
		]);
		const classifier = scriptedModel([
			[
				...text("c1", JSON.stringify({ decision: "on_track", reason: "ok" })),
				finish(20, 2),
			],
		]);
		const result = await trial(f, "rh-full", async (wrap, model) => ({
			model: wrap(
				model?.modelId === "claude-sonnet-5-5"
					? sidekick.model
					: model?.modelId === "claude-haiku-5-5"
						? classifier.model
						: lead.model,
			),
		}));
		expect(result.failure).toBeNull();
		const t = await trace(f.logs);
		expect(t.leadEffort).toBe("max");
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		expect(
			trajectory.agent.tool_definitions.map(
				(entry: { function: { name: string } }) => entry.function.name,
			),
		).toEqual(expect.arrayContaining(["write", "edit", "bash", "agent_send"]));
		expect(trajectory.steps[0].message).not.toContain(
			"You decide; your writer does.",
		);
	}, 120_000);

	it("reviews a turn that changed nothing in the checkout", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		const { model, calls } = scriptedModel([
			[...text("b1", "Wrote the result to /app/out.txt."), finish(100, 10)],
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
		]);
		const result = await trial(f, "rh-nochange", async (wrap) => ({
			model: wrap(model),
		}));
		expect(result.failure).toBeNull();
		expect(calls()).toBe(3);
		const t = await trace(f.logs);
		expect(t.review.checks).toHaveLength(1);
		expect(t.review.state.rounds[0].changedFiles).toBe(0);
		expect(t.review.state.outcome).toBe("pass");
	}, 120_000);

	it("sends back an answer that asks the user a question (rigor=on)", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on,rigor=on" });
		const { model, calls } = scriptedModel([
			[
				...text(
					"b1",
					"The spec and the tests disagree.\nPlease confirm whether solution.py should print 41 or 42.",
				),
				finish(100, 10),
			],
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
			[
				call("b2", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[
				...text("b3", "Done: prints 42 (assumed 42 per the request)."),
				finish(100, 10),
			],
			ran("k1b"),
			[...text("k2", verdict(true)), finish(100, 10)],
		]);
		const result = await trial(f, "rh-question", async (wrap) => ({
			model: wrap(model),
		}));
		expect(result.failure).toBeNull();
		expect(calls()).toBe(7);
		expect(result.reviewRounds).toBe(1);
		const [notice] = await notices(f.logs);
		expect(notice.message).toContain("Please confirm whether");
		expect(notice.message).toContain("Nobody will answer a question");
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
	}, 120_000);

	it("reviews a build that ran past the product's hour, with trial time left", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		let offset = 0;
		const now = () => Date.now() + offset;
		const deadlineAt = Date.now() + 3 * 60 * 60_000;
		const builder = scriptedModel([
			[
				call("b1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
			ran("k0"),
			[...text("k1", verdict(true)), finish(100, 10)],
		]);
		const original = builder.model.doStream.bind(builder.model);
		builder.model.doStream = async (options) => {
			// The build's first step takes 70 minutes.
			if (builder.calls() === 0) offset += 70 * 60_000;
			return original(options);
		};
		const result = await trial(
			f,
			"rh-long",
			async (wrap) => ({ model: wrap(builder.model) }),
			{ deadlineAt, now },
		);
		expect(result.failure).toBeNull();
		expect(builder.calls()).toBe(4);
		const t = await trace(f.logs);
		expect(t.review.checks).toHaveLength(1);
		expect(t.review.state.outcome).toBe("pass");
		// The window became the runner's deadline (less the grader's two minutes).
		expect(t.review.state.deadlineAt).toBe(deadlineAt - 120_000);
	}, 120_000);

	it("checks again once when the checker gives no verdict; the retry is not a round", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		const { model, calls } = scriptedModel([
			[
				call("b1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
			[
				...text("k1", "I ran out of time before writing a verdict."),
				finish(100, 10),
			],
			ran("k1b"),
			[...text("k2", verdict(true)), finish(100, 10)],
		]);
		const result = await trial(f, "rh-retry", async (wrap) => ({
			model: wrap(model),
		}));
		expect(result.failure).toBeNull();
		expect(calls()).toBe(5);
		expect(result.reviewRounds).toBe(0);
		const t = await trace(f.logs);
		expect(t.review.checks).toHaveLength(2);
		expect(
			t.review.state.rounds.map(
				(round: { decision: string }) => round.decision,
			),
		).toEqual(["retry", "pass"]);
	}, 120_000);

	it("gives a checker at its limit a final step with tools off; its verdict is recorded as forced-final", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT: "review=on",
			YTIMESY_HARBOR_TOTAL_USD_CAP: "20",
			YTIMESY_HARBOR_TRIAL_USD_CAP: "15",
		});
		const { model, calls } = scriptedModel([
			[
				call("b1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
			// The checker's step spends past its 800K-token budget.
			[
				call("k1", "bash", { command: "python3 solution.py" }),
				finish(900_000, 5, true),
			],
			[...text("k2", verdict(true)), finish(100, 10)],
		]);
		const result = await trial(f, "rh-final", async (wrap) => ({
			contextWindow: 4_000_000,
			model: wrap(model),
		}));
		expect(result.failure).toBeNull();
		expect(calls()).toBe(4);
		const final = model.doStreamCalls[3];
		expect(JSON.stringify(final.prompt)).toContain(
			"Final step, runtime notice: your time is up and tools are off.",
		);
		expect(final.tools ?? []).toEqual([]);
		const t = await trace(f.logs);
		expect(t.review.state.rounds[0].verdict).toMatchObject({
			verdict: "pass",
			via: "forced-final",
		});
		expect(JSON.stringify(t.review.state)).not.toContain("unsure");
	}, 120_000);

	it("hands the lead a sidekick's last message when its round stops at the token budget", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT:
				"lead=fusion,roleModels.writer=claude-opus-5-5,roleModels.classifier=claude-sonnet-5-5@low",
			// A cheap lead: the writer's tokens weigh 4x against the round budget,
			// so the cap is reached well inside the writer's context window.
			YTIMESY_HARBOR_MODEL: "claude-haiku-5-5",
			YTIMESY_HARBOR_TOTAL_USD_CAP: "20",
			YTIMESY_HARBOR_TRIAL_USD_CAP: "15",
		});
		const lead = scriptedModel([[...text("l1", "Done."), finish(100, 10)]]);
		// The exploration round spends past its round budget in one step, gets
		// the last-step notice, calls a tool anyway and is stopped.
		const sidekick = scriptedModel([
			[
				...text("s1", "Progress: parser.py has the bug; fix not written yet."),
				call("s1b", "bash", { command: "ls" }),
				finish(400_000, 5, true),
			],
			[call("s2", "bash", { command: "ls" }), finish(400_000, 5, true)],
			[...text("s3", "unreachable"), finish(50, 5)],
		]);
		const classifier = scriptedModel([
			[
				...text("c1", JSON.stringify({ decision: "on_track", reason: "ok" })),
				finish(20, 2),
			],
		]);
		const result = await trial(f, "rh-budget", async (wrap, model) => ({
			// Room for the whole round: the budget stops it, not compaction.
			contextWindow: 4_000_000,
			model: wrap(
				model?.modelId === "claude-opus-5-5"
					? sidekick.model
					: model?.modelId === "claude-sonnet-5-5"
						? classifier.model
						: lead.model,
			),
		}));
		expect(result.failure).toBeNull();
		expect(sidekick.calls()).toBe(2);
		expect(JSON.stringify(sidekick.model.doStreamCalls[1].prompt)).toContain(
			"Budget used",
		);
		expect(JSON.stringify(lead.model.doStreamCalls[0].prompt)).toContain(
			"Progress: parser.py has the bug; fix not written yet.",
		);
		const t = await trace(f.logs);
		expect(t.fusion.rounds[0]).toMatchObject({
			kind: "explore",
			outcome: "budget exhausted",
		});
	}, 120_000);

	it("resamples a step cut at the 64K output cap once, with the smaller-steps note", async () => {
		const f = await fixture();
		const { model, calls } = scriptedModel([
			// Reasoning ran to the cap: no text, no tool call.
			[
				{
					type: "finish",
					usage: usage(100, 64_000),
					finishReason: { unified: "length", raw: "max_output_tokens" },
				},
			],
			[
				call("b1", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b2", "Done."), finish(100, 10)],
		]);
		const result = await trial(f, "rh-cap", async (wrap) => ({
			model: wrap(model),
			maxOutputTokens: 64_000,
		}));
		expect(result.failure).toBeNull();
		expect(calls()).toBe(3);
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
			"Continue the same work in smaller steps",
		);
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
	}, 120_000);
});

describe("a cut-off checker's last word (bridge)", () => {
	it("finds the brief's findings file and lists what the checker ran with its output", () => {
		expect(
			briefFindingsPath(
				"append it as one JSON line to /tmp/ytimesy-attempts/t/review-1/findings.jsonl: {...}",
			),
		).toBe("/tmp/ytimesy-attempts/t/review-1/findings.jsonl");
		expect(briefFindingsPath("no file")).toBeNull();
		const at = new Date(0).toISOString();
		const events = [
			{ at, event: { type: "text-delta", id: "x", text: "hi" } },
			{
				at,
				event: {
					type: "tool-call",
					id: "c1",
					name: "bash",
					input: { command: "python3 /tmp/t.py" },
				},
			},
			{
				at,
				event: {
					type: "tool-result",
					id: "c1",
					name: "bash",
					output: "2 passed",
				},
			},
			{
				at,
				event: {
					type: "tool-call",
					id: "c2",
					name: "bash",
					input: { command: "sleep 999" },
				},
			},
		] as never;
		expect(ranTranscript(events, 0)).toBe(
			"$ python3 /tmp/t.py\n2 passed\n$ sleep 999\n(no output recorded)",
		);
		expect(ranTranscript(events, 3)).toBe("$ sleep 999\n(no output recorded)");
	});
});

describe("runHarborTrial rehearsal: the background-command completion gate", () => {
	const hasTmux = (() => {
		try {
			execFileSync("tmux", ["-V"], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	})();
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const trace = async (logs: string) =>
		JSON.parse(await readFile(join(logs, "ytimesy-trace.json"), "utf8"));

	/**
	 * A background command as the lean command tool's launch leaves it on the
	 * machine (api-agent-command-tools.ts launchCommand): `<id>.background`
	 * beside its output in the session's command root, a tmux session on the
	 * runtime socket, `<id>.status` written when it exits. Started directly
	 * because the runner's process fence reads /proc (Linux only).
	 */
	async function backgroundCommand(
		sessionId: string,
		spec: { seconds: number; output: string; exitCode: number },
	) {
		const id = crypto.randomUUID();
		const root = commandRoot(sessionId);
		const outputs = agentOutputDirectory(sessionId);
		await mkdir(root, { recursive: true });
		await mkdir(outputs, { recursive: true });
		await writeFile(
			`${root}/${id}.background`,
			JSON.stringify({ label: "python3 bench.py", startedAt: Date.now() }),
		);
		await writeFile(`${root}/${id}.output`, "");
		const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		execFileSync("tmux", [
			"-L",
			COMMAND_TMUX_SOCKET,
			"new-session",
			"-d",
			"-s",
			commandSessionName(id),
			`sleep ${spec.seconds}; printf %s ${q(spec.output)} > ${q(`${outputs}/${id}.stdout`)}; printf '%s\\n' ${spec.exitCode} > ${q(`${root}/${id}.status`)}`,
		]);
		cleanups.push(async () => {
			try {
				execFileSync(
					"tmux",
					[
						"-L",
						COMMAND_TMUX_SOCKET,
						"kill-session",
						"-t",
						commandSessionName(id),
					],
					{ stdio: "ignore" },
				);
			} catch {}
			await rm(root, { recursive: true, force: true });
			await rm(outputs, { recursive: true, force: true });
		});
		return { id, root };
	}
	const running = (id: string) => {
		try {
			execFileSync(
				"tmux",
				[
					"-L",
					COMMAND_TMUX_SOCKET,
					"has-session",
					"-t",
					commandSessionName(id),
				],
				{ stdio: "ignore" },
			);
			return true;
		} catch {
			return false;
		}
	};
	const promptText = (model: MockLanguageModelV4, call: number) =>
		JSON.stringify(model.doStreamCalls[call]?.prompt ?? null);

	it.skipIf(!hasTmux)(
		"waits for the background command the builder left running, then continues with its exit notice",
		async () => {
			const f = await fixture();
			const trialId = `bg-gate-${crypto.randomUUID().slice(0, 8)}`;
			let command = { id: "", root: "" };
			const { model, calls } = scriptedModel([
				[
					...text(
						"t1",
						"Started the final benchmark in the background; I'll report geometric means when it finishes.",
					),
					finish(100, 10),
				],
				[
					...text("t2", "Benchmark finished: geometric mean speedup 1.83x."),
					finish(120, 12),
				],
			]);
			const result = await runHarborTrial({
				config: f.config,
				trialId,
				instruction: "Speed up the benchmark and report its geometric mean.",
				cwd: f.checkout.root,
				logsDir: f.logs,
				deadlineAt: Date.now() + 3 * 60 * 60_000,
				machines: f.side.machines,
				userId: "harbor",
				storage: f.archives.storage,
				// Started as the builder's run begins (as its bash background option would).
				runtime: async (wrap) => {
					command = await backgroundCommand(trialId, {
						seconds: 1.5,
						output: "graph 1: 1.91x\ngraph 2: 1.75x\ngeomean 1.83x",
						exitCode: 0,
					});
					return { model: wrap(model) };
				},
				harness,
				backgroundPollMs: 200,
			});
			expect(result.failure).toBeNull();
			expect(calls()).toBe(2);
			const { id, root } = command;
			// The continuation read the product's notice: exit code and output tail.
			const continued = promptText(model, 1);
			expect(continued).toContain(
				`Background command ${id} (python3 bench.py) finished with exit 0`,
			);
			expect(continued).toContain("geomean 1.83x");
			expect(continued).toContain("Runtime notice, not a new user request.");
			expect(promptText(model, 0)).not.toContain(`Background command ${id}`);
			// Claimed: never announced again.
			expect(await readFile(`${root}/${id}.notified`, "utf8")).toBe("notice");
			const t = await trace(f.logs);
			expect(t.backgroundGates).toHaveLength(1);
			expect(t.backgroundGates[0]).toMatchObject({
				round: 1,
				ids: [id],
				outcome: "notified",
				exitCodes: { [id]: 0 },
				stillRunning: [],
			});
			expect(t.backgroundGates[0].waitedSeconds).toBeGreaterThan(0.5);
			expect(t.notices.at(-1).text).toContain("geomean 1.83x");
			// Usage counts both runs.
			expect(result.requests).toBe(2);
			expect(result.usage?.inputTokens).toBe(220);
			const trajectory = JSON.parse(
				await readFile(join(f.logs, "trajectory.json"), "utf8"),
			);
			// The notice is a user step between the two runs' answers.
			expect(
				trajectory.steps.map(
					(step: { source: string; extra?: { kind?: string } }) =>
						step.extra?.kind ?? step.source,
				),
			).toEqual(["system", "user", "agent", "runtime-notice", "agent"]);
			expect(trajectory.steps.at(-1).message).toBe(
				"Benchmark finished: geometric mean speedup 1.83x.",
			);
		},
		60_000,
	);

	it.skipIf(!hasTmux)(
		"stops waiting at the deadline margin: no continuation, the command keeps running, the trial ends cleanly",
		async () => {
			const f = await fixture();
			const trialId = `bg-late-${crypto.randomUUID().slice(0, 8)}`;
			let id = "";
			const { model, calls } = scriptedModel([
				[
					...text("t1", "Benchmark started in the background."),
					finish(100, 10),
				],
				[...text("t2", "never"), finish(1, 1)],
			]);
			const deadlineAt = Date.now() + 5_000;
			const result = await runHarborTrial({
				config: f.config,
				trialId,
				instruction: "Run the benchmark.",
				cwd: f.checkout.root,
				logsDir: f.logs,
				deadlineAt,
				machines: f.side.machines,
				userId: "harbor",
				storage: f.archives.storage,
				runtime: async (wrap) => {
					id = (
						await backgroundCommand(trialId, {
							seconds: 120,
							output: "late",
							exitCode: 0,
						})
					).id;
					return { model: wrap(model) };
				},
				harness,
				backgroundPollMs: 200,
			});
			expect(result.failure).toBeNull();
			expect(calls()).toBe(1);
			// The margin (10% of the time left, under 5 minutes) was left unspent.
			expect(Date.now()).toBeLessThan(deadlineAt);
			const t = await trace(f.logs);
			expect(t.backgroundGates).toEqual([
				expect.objectContaining({
					ids: [id],
					outcome: "deadline",
					stillRunning: [id],
				}),
			]);
			expect(t.notices).toEqual([]);
			// Not killed: the trial leaves it as is.
			expect(running(id)).toBe(true);
		},
		60_000,
	);

	it("runs no extra builder run when no background command was started", async () => {
		const f = await fixture();
		const { model, calls } = scriptedModel([
			[...text("t1", "Done."), finish(100, 10)],
			[...text("t2", "never"), finish(1, 1)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: `bg-none-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 3 * 60 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness,
			backgroundPollMs: 200,
		});
		expect(result.failure).toBeNull();
		expect(calls()).toBe(1);
		const t = await trace(f.logs);
		expect(t.backgroundGates).toEqual([]);
		expect(t.notices).toEqual([]);
	}, 60_000);
});

describe("runHarborTrial with grind=on", () => {
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const run = async (variant: string, deadlineMs: number) => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: variant });
		const { model, calls } = scriptedModel([
			[...text("g1", "Done."), finish(100, 10)],
			[...text("g2", "Checked again; done."), finish(100, 10)],
			[...text("g3", "Still holds; done."), finish(100, 10)],
			[...text("g4", "never"), finish(1, 1)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: `grind-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + deadlineMs,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness,
			backgroundPollMs: 200,
		});
		return { result, calls: calls(), logs: f.logs };
	};

	it("sends an early finish back at most twice, with the generic notice", async () => {
		const { result, calls, logs } = await run("grind=on", 3 * 60 * 60_000);
		expect(result.failure).toBeNull();
		expect(calls).toBe(3);
		const notices = JSON.parse(
			await readFile(join(logs, "ytimesy-trace.json"), "utf8"),
		).notices;
		expect(notices).toHaveLength(2);
		expect(notices[0].text).toContain("try to break your result");
	}, 60_000);

	it("stops at the first finish without grind or with too little time left", async () => {
		expect((await run("grind=off", 3 * 60 * 60_000)).calls).toBe(1);
		expect((await run("grind=on", 10 * 60_000)).calls).toBe(1);
	}, 60_000);
});

describe("grindNotice", () => {
	const hour = 60 * 60_000;
	it("asks for more work only early in a long enough run, at most twice", () => {
		const base = { startedAtMs: 0, deadlineAtMs: 8 * hour };
		expect(grindNotice({ ...base, nowMs: 20 * 60_000, rounds: 0 })).toContain(
			"460 minutes remain",
		);
		expect(grindNotice({ ...base, nowMs: 61 * 60_000, rounds: 0 })).toBeNull();
		expect(grindNotice({ ...base, nowMs: 20 * 60_000, rounds: 2 })).toBeNull();
		// A 1-hour task may finish after 15 minutes.
		expect(
			grindNotice({
				startedAtMs: 0,
				deadlineAtMs: hour,
				nowMs: 16 * 60_000,
				rounds: 0,
			}),
		).toBeNull();
		expect(grindMinimumMs(hour)).toBe(15 * 60_000);
	});
});

describe("runHarborTrial with effortMix=on", () => {
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const step = (id: string): Part[] => [
		call(id, "bash", { command: "true" }),
		finish(100, 10, true),
	];
	const run = async (env: Record<string, string>) => {
		const f = await fixture(env);
		const { model } = scriptedModel([
			step("e1"),
			step("e2"),
			step("e3"),
			[...text("d1", "Done."), finish(100, 10)],
			step("e4"),
			[...text("d2", "Checked again; done."), finish(100, 10)],
			[...text("d3", "Still holds; done."), finish(100, 10)],
		]);
		const lines: string[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: `mix-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 3 * 60 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			// The routes' request settings name the turn's effort.
			runtime: async (wrap) => ({
				model: wrap(model),
				requestSettings: (instructions) => ({
					system: instructions,
					providerOptions: { anthropic: { effort: f.config.effort } },
				}),
			}),
			harness,
			backgroundPollMs: 200,
			log: (line) => lines.push(line),
		});
		expect(result.failure).toBeNull();
		return {
			sent: model.doStreamCalls.map(
				(entry) => entry.providerOptions?.anthropic?.effort,
			),
			logged: lines.filter((line) => line.startsWith("effort ")),
		};
	};

	it("plans and continues at the turn's effort and executes at high", async () => {
		const { sent, logged } = await run({
			YTIMESY_HARBOR_VARIANT: "grind=on,effortMix=on",
		});
		// Two planning requests, execution, then two grind continuation rounds.
		expect(sent).toEqual(["max", "max", "high", "high", "max", "max", "max"]);
		expect(logged).toEqual([
			"effort 1 max",
			"effort 2 max",
			"effort 3 high",
			"effort 4 high",
			"effort 5 max",
			"effort 6 max",
			"effort 7 max",
		]);
	}, 60_000);

	it("leaves every request at the turn's effort when off or at high", async () => {
		const off = await run({ YTIMESY_HARBOR_VARIANT: "grind=on" });
		expect(new Set(off.sent)).toEqual(new Set(["max"]));
		expect(off.logged).toEqual([]);
		const high = await run({
			YTIMESY_HARBOR_VARIANT: "grind=on,effortMix=on",
			YTIMESY_HARBOR_EFFORT: "high",
		});
		expect(new Set(high.sent)).toEqual(new Set(["high"]));
		expect(high.logged).toHaveLength(7);
	}, 60_000);
});

describe("runHarborTrial with envSnapshot=on", () => {
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const run = async (variant: string) => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: variant });
		const { model } = scriptedModel([
			[...text("e1", "Done."), finish(100, 10)],
		]);
		const lines: string[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: `env-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 120_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness,
			log: (line) => lines.push(line),
		});
		const prompt = JSON.stringify(model.doStreamCalls[0].prompt);
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		return { result, prompt, lines, trajectory, commands: f.side.commands };
	};

	it("puts the sandbox probe's facts above the request, logged and in the trajectory", async () => {
		const { result, prompt, lines, trajectory, commands } =
			await run("envSnapshot=on");
		expect(result.failure).toBeNull();
		expect(prompt).toContain(ENV_SNAPSHOT_HEADER);
		expect(prompt).toContain("## Files");
		expect(prompt.indexOf(ENV_SNAPSHOT_HEADER)).toBeLessThan(
			prompt.indexOf("Say done."),
		);
		expect(lines.some((line) => /^env snapshot \d+ chars$/.test(line))).toBe(
			true,
		);
		expect(trajectory.steps[1].message).toContain(ENV_SNAPSHOT_HEADER);
		expect(commands.filter((c) => c.includes("## System"))).toHaveLength(1);
	}, 60_000);

	it("sends the request alone when off", async () => {
		const { prompt, trajectory, commands } = await run("envSnapshot=off");
		expect(prompt).not.toContain(ENV_SNAPSHOT_HEADER);
		expect(trajectory.steps[1].message).toBe("Say done.");
		expect(commands.some((c) => c.includes("## System"))).toBe(false);
	}, 60_000);
});

describe("envSnapshot", () => {
	const vm = WorkspaceId("harbor");
	const machines = (exec: () => Promise<unknown>) =>
		({ exec }) as unknown as WorkspaceMachines;

	it("caps long output with a cut note and gives up quietly on a failed probe", async () => {
		const long = await envSnapshot({
			machines: machines(async () => ({
				stdout: "x".repeat(ENV_SNAPSHOT_MAX_CHARS + 500),
				stderr: "",
				exitCode: 0,
			})),
			vm,
			cwd: "/app",
		});
		expect(long?.startsWith(ENV_SNAPSHOT_HEADER)).toBe(true);
		expect(long).toContain(
			`[snapshot cut at ${ENV_SNAPSHOT_MAX_CHARS} of ${ENV_SNAPSHOT_MAX_CHARS + 500} chars]`,
		);
		expect(
			await envSnapshot({
				machines: machines(async () => {
					throw new Error("sandbox gone");
				}),
				vm,
				cwd: "/app",
			}),
		).toBeNull();
		expect(
			await envSnapshot({
				machines: machines(async () => ({
					stdout: "  \n",
					stderr: "",
					exitCode: 124,
				})),
				vm,
				cwd: "/app",
			}),
		).toBeNull();
	});

	it("quotes the working directory and writes nothing", () => {
		const probe = envSnapshotProbe("/app's dir");
		expect(probe).toContain(`cd '/app'\\''s dir'`);
		expect(probe).not.toMatch(/\b(rm|mv|cp|tee|mkdir|install)\b/);
	});
});

describe("runHarborTrial with ledger=on", () => {
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const instruction = "Create done.txt containing ok.";
	const run = async (
		variant: string,
		responses: Part[][],
		deadlineMs = 3 * 60 * 60_000,
	) => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: variant });
		const { model, calls } = scriptedModel(responses);
		const lines: string[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: `ledger-${crypto.randomUUID().slice(0, 8)}`,
			instruction,
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + deadlineMs,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness,
			backgroundPollMs: 200,
			log: (line) => lines.push(line),
		});
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		return { result, calls: calls(), lines, trace, trajectory };
	};
	const requirements = [
		{
			id: "R1",
			quote: "Create done.txt containing ok",
			check: "grep -qx ok done.txt",
		},
	];
	const done = (id: string): Part[] => [...text(id, "Done."), finish(100, 10)];

	it("records the ledger with the direct tool, runs its checks at the finish and sends a failure back", async () => {
		const { result, calls, lines, trace, trajectory } = await run("ledger=on", [
			[
				call("l1", "requirements", { op: "set", requirements }),
				finish(100, 10, true),
			],
			done("d1"),
			[
				call("w1", "write", { path: "done.txt", content: "ok\n" }),
				finish(100, 10, true),
			],
			done("d2"),
			done("never"),
		]);
		expect(result.failure).toBeNull();
		expect(calls).toBe(4);
		expect(trajectory.steps[1].message).toContain(
			'Harness note: before you build, record this request\'s requirements with the requirements tool (op "set")',
		);
		expect(trajectory.steps[1].message.startsWith(instruction)).toBe(true);
		expect(lines).toContain("ledger set 1 items");
		expect(lines).toContain("ledger gate round 1: 1/1 failed");
		expect(lines).toContain("ledger gate round 2: 0/1 failed");
		expect(trace.notices).toHaveLength(1);
		expect(trace.notices[0].continuation).toBe("ledger");
		expect(trace.notices[0].text).toContain("1 of 1 failed");
		expect(trace.notices[0].text).toContain(
			'- R1: "Create done.txt containing ok"',
		);
		expect(trace.notices[0].text).toContain("check: grep -qx ok done.txt");
		expect(trace.notices[0].text).toMatch(/exit code: [1-9]/);
		expect(trace.ledger.items).toEqual(requirements);
		expect(
			trace.ledger.gates.map((gate: { sentBack: boolean }) => gate.sentBack),
		).toEqual([true, false]);
		expect(
			trace.builderRuns.map(
				(entry: { continuation: string | null }) => entry.continuation,
			),
		).toEqual([null, "ledger"]);
	}, 60_000);

	it("takes the ledger from a code mode program", async () => {
		const { calls, lines, trace } = await run("ledger=on,codeMode=primary", [
			[
				call("p1", "run_code", {
					code: `await tools.write({ path: "done.txt", content: "ok\\n" }); return await tools.requirements(${JSON.stringify({ op: "set", requirements })});`,
				}),
				finish(100, 10, true),
			],
			done("d1"),
			done("never"),
		]);
		expect(calls).toBe(2);
		expect(lines).toContain("ledger set 1 items");
		expect(lines).toContain("ledger gate round 1: 0/1 failed");
		expect(trace.notices).toEqual([]);
	}, 60_000);

	it("sends a finish without a ledger back at most twice, then lets grind use what is left of the shared cap", async () => {
		const missing = await run("ledger=on", [done("d1")]);
		expect(missing.calls).toBe(3);
		expect(missing.lines).toContain("ledger gate round 1: no ledger recorded");
		expect(missing.trace.notices[0].text).toContain(
			"You finished without recording the request's requirements.",
		);
		const both = await run("ledger=on,grind=on", [done("d1")]);
		// Two ledger rounds, then one grind round: three continuations at most.
		expect(both.calls).toBe(4);
		expect(
			both.trace.notices.map(
				(notice: { continuation: string }) => notice.continuation,
			),
		).toEqual(["ledger", "ledger", "grind"]);
	}, 60_000);

	it("changes nothing when off, and skips the gate with too little time left", async () => {
		const off = await run("ledger=off", [done("d1")]);
		expect(off.calls).toBe(1);
		expect(off.trajectory.steps[1].message).toBe(instruction);
		expect(off.trace.ledger).toBeNull();
		const late = await run("ledger=on", [done("d1")], 5 * 60_000);
		expect(late.calls).toBe(1);
		expect(
			late.lines.some((line) => line.startsWith("ledger gate skipped")),
		).toBe(true);
	}, 60_000);
});

describe("requirementsTool", () => {
	const execute = (ledger: LedgerState, args: unknown, lines: string[] = []) =>
		(
			requirementsTool({
				state: ledger,
				instruction: "Sort the  list\nin place.",
				now: () => 0,
				log: (line) => lines.push(line),
			})[REQUIREMENTS_TOOL].execute as (
				args: unknown,
				options: unknown,
			) => Promise<string>
		)(args, { toolCallId: "t", messages: [] });

	it("replaces the list, logs each set and flags quotes the request does not contain", async () => {
		const ledger: LedgerState = { items: null, sets: [] };
		const lines: string[] = [];
		expect(await execute(ledger, { op: "get" })).toBe(
			"No requirements recorded yet.",
		);
		const item = { id: "R1", quote: "sort the list in place", check: "true" };
		expect(
			await execute(ledger, { op: "set", requirements: [item] }, lines),
		).not.toContain("Not found");
		const second = await execute(
			ledger,
			{
				op: "set",
				requirements: [
					item,
					{
						id: "R2",
						quote: "stable",
						readings: [
							{ reading: "a", satisfied: false },
							{ reading: "b", satisfied: false },
						],
						check: "true",
					},
				],
			},
			lines,
		);
		expect(second).toContain("replacing the earlier 1");
		expect(second).toContain("Not found word for word in the request: R2.");
		expect(second).toContain("No reading marked satisfied: R2.");
		expect(lines).toEqual([
			"ledger set 1 items",
			"ledger set 2 items (replaced 1)",
		]);
		expect(
			await execute(ledger, { op: "set", requirements: [item, item] }),
		).toContain("ids must be unique (repeated: R1)");
		expect(ledger.items).toHaveLength(2);
		expect(JSON.parse(await execute(ledger, { op: "get" }))[1].id).toBe("R2");
	});
});

describe("runHarborTrial with goal=on", () => {
	const harness = {
		name: "ytimesy",
		version: "test",
		commit: null,
		bundleSha256: null,
	};
	const done = (id: string): Part[] => [...text(id, "Done."), finish(100, 10)];
	const bash = (id: string): Part[] => [
		call(id, "bash", { command: "true" }),
		finish(100, 10, true),
	];
	const run = async (
		variant: string,
		responses: Part[][],
		deadlineMs = 3 * 60 * 60_000,
	) => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: variant });
		const { model, calls } = scriptedModel(responses);
		const lines: string[] = [];
		const result = await runHarborTrial({
			config: f.config,
			trialId: `goal-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + deadlineMs,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness,
			backgroundPollMs: 200,
			log: (line) => lines.push(line),
		});
		expect(result.failure).toBeNull();
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		return {
			calls: calls(),
			goalLines: lines.filter((line) => line.startsWith("goal ")),
			trace,
			model,
		};
	};

	it("sets the request as the goal and continues until the builder marks it complete with evidence", async () => {
		const { calls, goalLines, trace, model } = await run("goal=on,grind=on", [
			done("g1"),
			[
				call("u1", "goal", {
					op: "update",
					status: "complete",
					evidence: [{ requirement: "Say done.", proof: "echo done -> done" }],
				}),
				finish(100, 10, true),
			],
			done("g2"),
			done("never"),
		]);
		expect(calls).toBe(3);
		expect(goalLines).toEqual([
			"goal set",
			"goal continuation 1",
			"goal update complete (1 evidence)",
			"goal evidence 1: Say done. => echo done -> done",
			"goal stop complete",
		]);
		const first = JSON.stringify(model.doStreamCalls[0].prompt);
		expect(first).toContain("the request above is this run's goal");
		expect(JSON.stringify(model.doStreamCalls[0].tools)).toContain('"goal"');
		// Goal supersedes grind: one notice, the goal's.
		expect(trace.notices).toHaveLength(1);
		expect(trace.notices[0].text).toContain(
			"<objective>\nSay done.\n</objective>",
		);
		expect(trace.notices[0].text).not.toContain("try to break");
		expect(trace.goal).toMatchObject({
			status: "complete",
			stopReason: "complete",
			continuations: 1,
			claim: {
				evidence: [{ requirement: "Say done.", proof: "echo done -> done" }],
				unquoted: 0,
			},
		});
	}, 60_000);

	it("stops after three continuation turns without a tool call", async () => {
		const { calls, goalLines, trace } = await run("goal=on", [done("g1")]);
		expect(calls).toBe(4);
		expect(goalLines.at(-1)).toBe("goal stop no-progress");
		expect(trace.goal.status).toBe("blocked");
	}, 60_000);

	it("caps continuations at six", async () => {
		const responses = Array.from({ length: 7 }, (_, index) => [
			bash(`b${index}`),
			done(`d${index}`),
		]).flat();
		const { calls, goalLines } = await run("goal=on", responses);
		expect(calls).toBe(14);
		expect(
			goalLines.filter((line) => line.startsWith("goal continuation")),
		).toHaveLength(6);
		expect(goalLines.at(-1)).toBe("goal stop max-continuations");
	}, 60_000);

	it("sends one wrap-up line near the deadline instead of a continuation", async () => {
		const { calls, goalLines, trace } = await run(
			"goal=on",
			[done("g1"), done("g2"), done("never")],
			3 * 60_000,
		);
		expect(calls).toBe(2);
		expect(goalLines).toEqual([
			"goal set",
			"goal stop deadline (wrap-up sent)",
		]);
		expect(trace.notices[0].text).toContain("Time is nearly up");
	}, 60_000);

	it("offers the goal tool directly and to run_code programs", async () => {
		const { model } = await run("goal=on,codeMode=on", [
			[
				call("u1", "goal", {
					op: "update",
					status: "blocked",
					reason: "No network.",
				}),
				finish(100, 10, true),
			],
			done("g1"),
		]);
		const tools = JSON.stringify(model.doStreamCalls[0].tools);
		expect(tools).toContain('"name":"goal"');
		expect(tools).toContain("tools.goal");
	}, 60_000);

	it("leaves the run unchanged when off", async () => {
		const { calls, goalLines, trace, model } = await run("goal=off", [
			done("g1"),
			done("never"),
		]);
		expect(calls).toBe(1);
		expect(goalLines).toEqual([]);
		expect(trace.goal).toBeNull();
		expect(JSON.stringify(model.doStreamCalls[0].tools)).not.toContain(
			'"goal"',
		);
	}, 60_000);
});

describe("runHarborTrial with plan=on and helpers=on", () => {
	it("records the plan, runs a read-only helper in its own copy and counts its usage", async () => {
		const f = await fixture({
			YTIMESY_HARBOR_VARIANT: "codeMode=primary,plan=on,helpers=on",
		});
		const plan = [
			{ step: "Ask a helper what exists", status: "in_progress" },
			{ step: "Write solution.py", status: "pending" },
		];
		// Builder and helper share the builder's model: one script, in call order.
		const { model, calls } = scriptedModel([
			[call("p1", "update_plan", { plan }), finish(100, 10, true)],
			[
				call("a1", "agent", {
					role: "researcher",
					title: "List files",
					brief: "List the files and report them.",
					wait: true,
				}),
				finish(100, 10, true),
			],
			// The helper: a command that writes, in its copy only.
			[
				call("h1", "bash", { command: "echo seen > helper-note.txt; ls" }),
				finish(40, 4, true),
			],
			[...text("h2", "Files: README.md, helper-note.txt"), finish(40, 4)],
			[
				call("b3", "write", { path: "solution.py", content: "print(42)\n" }),
				finish(100, 10, true),
			],
			[...text("b4", "Done."), finish(100, 10)],
		]);
		const result = await runHarborTrial({
			config: f.config,
			trialId: "trial-helpers",
			instruction: "Create solution.py that prints 42.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(model) }),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		expect(result.failure).toBeNull();
		expect(calls()).toBe(6);
		const builderTools = JSON.stringify(model.doStreamCalls[0].tools);
		for (const name of ["update_plan", "agent", "agent_wait", "agent_send"])
			expect(builderTools).toContain(`"name":"${name}"`);
		// Under codeMode=primary programs may call them too.
		expect(builderTools).toContain("tools.update_plan");
		// helpers=on's own section replaces the product's writer-delegation text.
		const builderPrompt = JSON.stringify(model.doStreamCalls[0].prompt);
		expect(builderPrompt).toContain(
			"independent investigation likely to take over 10 minutes",
		);
		expect(builderPrompt).not.toContain("start writers in parallel");
		// The helper is a reader: no write or edit tool, no agent tools.
		const helperTools = (model.doStreamCalls[2].tools ?? []).map(
			(entry: { name: string }) => entry.name,
		);
		expect(helperTools).not.toContain("write");
		expect(helperTools).not.toContain("edit");
		expect(helperTools).not.toContain("agent");
		// Its report reached the builder.
		expect(JSON.stringify(model.doStreamCalls[4].prompt)).toContain(
			"Files: README.md, helper-note.txt",
		);
		// It wrote only in its own copy; the builder's write is in the checkout.
		await expect(
			readFile(join(f.checkout.root, "helper-note.txt")),
		).rejects.toThrow();
		expect(await readFile(join(f.checkout.root, "solution.py"), "utf8")).toBe(
			"print(42)\n",
		);
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		expect(trace.plan).toEqual([{ at: expect.any(String), plan }]);
		expect(trace.review.readerCopies[0]).toMatchObject({
			sessionId: "trial-helpers.1",
			ok: true,
		});
		expect(trace.checkers[0]).toMatchObject({
			sessionId: "trial-helpers.1",
			role: "helper",
		});
		// Its usage is the trial's: 4 builder and 2 helper requests.
		expect(result.usage?.requests).toBe(6);
		expect(
			result.efficiency?.models.map((row) => [row.role, row.requests]),
		).toEqual([
			["builder", 4],
			// The product's tree labels a reader child "subagent".
			["subagent", 2],
		]);
		const trajectory = JSON.parse(
			await readFile(join(f.logs, "trajectory.json"), "utf8"),
		);
		expect(trajectory.final_metrics.extra.plan).toEqual(trace.plan);
		expect(trajectory.subagent_trajectories[0].agent.name).toBe(
			"ytimesy-helper",
		);
	}, 120_000);
});

describe("runHarborTrial with fetch=on", () => {
	it("offers web_fetch directly and to run_code programs, and not when off", async () => {
		const tools = async (variant: string) => {
			const f = await fixture({ YTIMESY_HARBOR_VARIANT: variant });
			const { model } = scriptedModel([[...text("d", "Done."), finish(10, 1)]]);
			const result = await runHarborTrial({
				config: f.config,
				trialId: `fetch-${crypto.randomUUID().slice(0, 8)}`,
				instruction: "Say done.",
				cwd: f.checkout.root,
				logsDir: f.logs,
				deadlineAt: Date.now() + 30 * 60_000,
				machines: f.side.machines,
				userId: "harbor",
				storage: f.archives.storage,
				runtime: async (wrap) => ({ model: wrap(model) }),
				harness: {
					name: "ytimesy",
					version: "test",
					commit: null,
					bundleSha256: null,
				},
			});
			expect(result.failure).toBeNull();
			return JSON.stringify(model.doStreamCalls[0].tools);
		};
		const on = await tools("codeMode=primary,fetch=on");
		expect(on).toContain('"name":"web_fetch"');
		expect(on).toContain("tools.web_fetch");
		expect(await tools("codeMode=primary")).not.toContain("web_fetch");
	}, 60_000);
});

describe("runHarborTrial with search=function", () => {
	const run = async (variant: string, responses: Part[][]) => {
		const f = await fixture({
			YTIMESY_HARBOR_WEB_SEARCH: "on",
			YTIMESY_HARBOR_VARIANT: variant,
		});
		const scripted = scriptedModel(responses);
		const result = await runHarborTrial({
			config: f.config,
			trialId: `search-${crypto.randomUUID().slice(0, 8)}`,
			instruction: "Find the docs, then say done.",
			cwd: f.checkout.root,
			logsDir: f.logs,
			deadlineAt: Date.now() + 30 * 60_000,
			machines: f.side.machines,
			userId: "harbor",
			storage: f.archives.storage,
			runtime: async (wrap) => ({ model: wrap(scripted.model) }),
			harness: {
				name: "ytimesy",
				version: "test",
				commit: null,
				bundleSha256: null,
			},
		});
		const trace = JSON.parse(
			await readFile(join(f.logs, "ytimesy-trace.json"), "utf8"),
		);
		return { ...scripted, result, trace };
	};
	const toolsOf = (call: { tools?: unknown }) =>
		((call.tools ?? []) as { type: string; name: string }[]).map(
			(entry) => `${entry.type}:${entry.name}`,
		);

	it("offers a function web_search whose call is its own request with the hosted tool, counted in usage", async () => {
		const { model, calls, result, trace } = await run(
			"codeMode=on,search=function",
			[
				[
					call("s1", "web_search", { query: "harbor docs" }),
					finish(100, 10, true),
				],
				// The call's own request: hosted search only, answers in text.
				[
					...text("q1", "Found: https://example.com/harbor-docs"),
					finish(30, 8),
				],
				[...text("d1", "Done."), finish(120, 5)],
			],
		);
		expect(result.failure).toBeNull();
		expect(calls()).toBe(3);
		const builder = toolsOf(model.doStreamCalls[0]);
		expect(builder).toContain("function:web_search");
		expect(builder.some((entry) => entry.startsWith("provider:"))).toBe(false);
		// run_code programs may call it too.
		expect(JSON.stringify(model.doStreamCalls[0].tools)).toContain(
			"tools.web_search",
		);
		const search = toolsOf(model.doStreamCalls[1]);
		expect(search).toHaveLength(1);
		expect(search[0]).toMatch(/^provider:/);
		expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
			"harbor docs",
		);
		expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain(
			"https://example.com/harbor-docs",
		);
		expect(result.usage?.requests).toBe(3);
		expect(result.usage?.inputTokens).toBe(250);
		expect(trace.checkers).toEqual([
			expect.objectContaining({ role: "search", brief: "harbor docs" }),
		]);
	}, 120_000);

	it("keeps the hosted tool in every request by default", async () => {
		const { model } = await run("codeMode=on", [
			[...text("d1", "Done."), finish(10, 1)],
		]);
		const builder = toolsOf(model.doStreamCalls[0]);
		expect(builder.some((entry) => entry.startsWith("provider:"))).toBe(true);
		expect(builder).not.toContain("function:web_search");
	}, 120_000);
});
