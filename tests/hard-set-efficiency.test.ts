import { describe, expect, it } from "vitest";
import {
	efficiencyRow,
	efficiencyTable,
	toolCallSummary,
} from "../scripts/hard-set/turn-record";
import { SessionItemId } from "../src/domain/ids";
import type { SessionItem } from "../src/domain/session-item";

const call = (tool: string, at: number | undefined, ms: number) => ({
	tool,
	input: "{}",
	status: "completed",
	ms,
	...(at === undefined ? {} : { at }),
	output: "",
});

const program = (
	id: string,
	calls: ReturnType<typeof call>[],
): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId(id),
	tool: "run_code",
	status: "completed",
	output: JSON.stringify({ ok: true, calls }),
});

const base = {
	task: "shadow-relay",
	attempt: "1",
	variant: "codeMode=primary",
	passed: true,
	modelSteps: 10,
	inputTokens: 200_000,
	cachedTokens: 150_000,
	agentSec: 300,
	toolCalls: 9,
};

describe("hard-set efficiency", () => {
	it("counts run_code programs, inner calls and programs that ran calls at once", () => {
		const summary = toolCallSummary(
			[
				program("p1", [
					call("read", 0, 50),
					call("read", 5, 50),
					call("bash", 10, 400),
				]),
				program("p2", [call("edit", 0, 10), call("bash", 20, 300)]),
				{
					kind: "dynamicToolCall",
					id: SessionItemId("b"),
					tool: "bash",
					status: "completed",
				},
			],
			[],
		);
		expect(summary.runCode.innerPerProgram).toEqual([3, 2]);
		expect(summary.runCode.concurrencyPerProgram).toEqual([3, 1]);
		const row = efficiencyRow({ ...base, toolSummary: summary }, 0.12);
		expect(row).toMatchObject({
			steps: 10,
			runCode: 2,
			inner: 5,
			parallelPrograms: 1,
			inputPerStep: 20_000,
			costUsd: 0.12,
		});
	});

	it("reads older records without run_code detail and averages per group", () => {
		const older = efficiencyRow(
			{ ...base, toolsUsed: { bash: 5, run_code: 2 }, toolSummary: null },
			null,
			false,
		);
		expect(older).toMatchObject({
			runCode: 2,
			inner: null,
			parallelPrograms: null,
			passed: null,
		});
		const none = efficiencyRow({ ...base, toolsUsed: { bash: 9 } }, 0.1);
		expect(none).toMatchObject({ runCode: 0, inner: 0, parallelPrograms: 0 });
		const table = efficiencyTable([older, none]);
		expect(table[0]).toContain("in/step");
		const mean = table.at(-1) ?? [];
		expect(mean[0]).toBe("mean of 2");
		expect(mean[2]).toBe("1/1");
		expect(mean[5]).toBe("1.0");
	});
});
