import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
	HARBOR_REQUEST,
	harborChannel,
	harborMachines,
} from "../evals/harbor_v2/harbor-machines";
import { ledgerSummary } from "../evals/harbor_v2/spend";
import { runHarborTrial } from "../evals/harbor_v2/trial";
import { modelBilling, usageCostUsd } from "../src/domain/model-pricing";
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
	it("runs the product's review loop in process: checker findings go back to the builder, checker edits are undone", async () => {
		const f = await fixture({ YTIMESY_HARBOR_VARIANT: "review=on" });
		const failing = JSON.stringify({
			verdict: "fail",
			failures: ["Output: solution.py prints 41, the request asks for 42"],
			requirements: [
				{
					requirement: "prints 42",
					met: false,
					evidence: "python3 solution.py -> 41",
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
					evidence: "python3 solution.py -> 42",
				},
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
				call("k1", "bash", { command: "echo checker scratch > stray.txt" }),
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
		expect(calls()).toBe(7);
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
		expect(trace.review.checks[0].restored).toBe(true);
		expect(trace.review.summary).toBeTruthy();
		// Builder and checkers count against one trial: 7 requests, 700 + 70 tokens.
		expect(result.requests).toBe(7);
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
					evidence: "python3 solution.py -> 42",
				},
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
		expect(checker.calls()).toBe(1);
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
			callsPerTask: 3,
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
			["checker", "claude-sonnet-5-5", 1],
		]);
		expect(trace.efficiency.perTaskUsd).toBeCloseTo(expected, 8);
		expect(trajectory.final_metrics.extra.efficiency.callsPerTask).toBe(3);
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
});
