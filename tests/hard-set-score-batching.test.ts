import { expect, it } from "vitest";
import {
	batchingReport,
	missedBatching,
	reasonProgramTools,
	scoreReasonTrajectory,
	scoreTranscript,
} from "../scripts/hard-set/score-batching";

const turn = "a967a816-f26c-4488-8f02-53e70dfc34b7";

function program(
	step: number,
	calls: { tool: string; status?: string; at: number; ms: number }[],
	ok = true,
) {
	return {
		id: `${turn}:step-${step}:call_${step}`,
		kind: "dynamicToolCall",
		tool: "run_code",
		input: JSON.stringify({ code: "…" }),
		status: "completed",
		output: JSON.stringify({
			ok,
			result: "done",
			calls: calls.map((call) => ({
				input: "{}",
				output: "",
				status: "completed",
				...call,
			})),
		}),
	};
}

function direct(step: number, tool: string, status = "completed") {
	return {
		id: `${turn}:step-${step}:call_${step}_${tool}`,
		kind: "dynamicToolCall",
		tool,
		input: "{}",
		output: "",
		status,
	};
}

it("counts a boundary after each write-only step as missed batching (the mvcc 4-6 shape)", () => {
	const scored = scoreTranscript({
		run: "smoke-all-1",
		task: "mvcc-lsm-compaction",
		record: { passed: false, modelSteps: 10 },
		transcript: {
			items: [
				{ id: "user", kind: "userMessage", text: "Fix it." },
				direct(1, "bash"),
				direct(2, "bash"),
				direct(3, "bash"),
				program(4, [{ tool: "edit", at: 0, ms: 300 }]),
				program(5, [{ tool: "edit", at: 0, ms: 300 }]),
				program(6, [
					{ tool: "edit", at: 0, ms: 300 },
					{ tool: "bash", at: 310, ms: 9000 },
				]),
				direct(7, "bash"),
				// The review loop's own calls are not model steps.
				{
					id: `review-loop:${turn}:1`,
					kind: "dynamicToolCall",
					tool: "review_check",
					input: "",
					output: "",
					status: "completed",
				},
			],
		},
	});
	expect(scored).toMatchObject({
		source: "ytimesy",
		passed: false,
		modelSteps: 10,
		toolSteps: 7,
		programs: 3,
		innerCalls: 4,
		innerPerProgram: [1, 1, 2],
		concurrencyPerProgram: [1, 1, 1],
		missedBatching: 2,
		missedAfter: [4, 5],
	});
});

it("needs the result of reads, commands and failed edits, and measures concurrency", () => {
	const scored = scoreTranscript({
		run: "r",
		task: "t",
		transcript: {
			items: [
				program(1, [
					{ tool: "read", at: 0, ms: 50 },
					{ tool: "read", at: 0, ms: 50 },
					{ tool: "bash", at: 1, ms: 40 },
				]),
				program(2, [{ tool: "edit", status: "failed", at: 0, ms: 5 }]),
				direct(3, "edit", "failed"),
				direct(4, "edit"),
				direct(4, "write"),
				direct(5, "bash"),
			],
		},
	});
	expect(scored.concurrencyPerProgram).toEqual([3, 1]);
	expect(scored.modelSteps).toBe(5);
	expect(scored.missedAfter).toEqual([4]);
	expect(missedBatching([])).toEqual([]);
});

it("scores a Reason trajectory the same way, counting inner calls from the program source", () => {
	expect(
		reasonProgramTools(
			"const r = await Promise.allSettled([tools.read({path}), tools.bash ({command})]); paths.map(p => tools.read({path: p}));",
		),
	).toEqual(["read", "bash", "read"]);
	const scored = scoreReasonTrajectory({
		run: "mvcc-lsm-compaction__UAUmBXs",
		task: "mvcc-lsm-compaction",
		reward: 1,
		trajectory: {
			steps: [
				{ step_id: 1, source: "user" },
				{
					step_id: 2,
					source: "agent",
					tool_calls: [
						{
							function_name: "codemode",
							arguments: { code: "text(await tools.read({path:'a'}))" },
						},
					],
				},
				{
					step_id: 3,
					source: "agent",
					tool_calls: [{ function_name: "edit" }],
				},
				{
					step_id: 4,
					source: "agent",
					tool_calls: [
						{
							function_name: "codemode",
							arguments: {
								code: "await tools.edit({}); text(await tools.bash({command:'make test'}))",
							},
						},
					],
				},
				{ step_id: 5, source: "agent", tool_calls: [] },
			],
		},
	});
	expect(scored).toMatchObject({
		source: "reason",
		passed: true,
		modelSteps: 4,
		toolSteps: 3,
		programs: 2,
		innerPerProgram: [1, 2],
		concurrencyPerProgram: [null, null],
		missedAfter: [3],
	});
	const report = batchingReport([scored]);
	expect(report).toContain(
		"| mvcc-lsm-compaction | - | 4 steps, 1 missed (1 run, 1 passed) |",
	);
});

it("reads hard-set and builder smoke transcripts from a run directory", async () => {
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { loadTranscriptScores } = await import(
		"../scripts/hard-set/score-batching"
	);
	const directory = mkdtempSync(join(tmpdir(), "score-batching-"));
	const items = [
		program(1, [{ tool: "edit", at: 0, ms: 1 }]),
		direct(2, "bash"),
	];
	writeFileSync(
		join(directory, "mvcc-lsm-compaction.1.transcript.json"),
		JSON.stringify({ items, requests: { requests: [] } }),
	);
	writeFileSync(
		join(directory, "mvcc-lsm-compaction.1.json"),
		JSON.stringify({ passed: true, modelSteps: 3 }),
	);
	writeFileSync(
		join(directory, "codex_gpt-6.1-sol-long-build-parallel-1-1.json"),
		JSON.stringify({
			record: { task: "long-build-parallel", verifierPassed: false },
			items,
		}),
	);
	const scores = loadTranscriptScores([directory]);
	expect(
		scores.map((score) => [
			score.task,
			score.passed,
			score.modelSteps,
			score.missedAfter,
		]),
	).toEqual([
		["long-build-parallel", false, 2, [1]],
		["mvcc-lsm-compaction", true, 3, [1]],
	]);
});
