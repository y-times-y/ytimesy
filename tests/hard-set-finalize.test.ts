import { describe, expect, it, vi } from "vitest";
import { wakeForFinalize } from "../scripts/hard-set/detached";
import { reviewLoopReport } from "../scripts/hard-set/review-report";
import { toolCallLine, toolCallSummary } from "../scripts/hard-set/turn-record";
import { SessionItemId } from "../src/domain/ids";
import type { SessionItem } from "../src/domain/session-item";

const vm = (states: (string | null | Error)[]) => {
	const queue = [...states];
	return {
		state: vi.fn(async () => {
			const next = queue.length > 1 ? queue.shift() : queue[0];
			if (next instanceof Error) throw next;
			return next ?? null;
		}),
		resume: vi.fn(async () => {}),
		hold: vi.fn(async () => {}),
		sleep: vi.fn(async () => {}),
	};
};

describe("hard set finalize wakes the agent VM", () => {
	it("leaves a running VM alone and holds it awake", async () => {
		const deps = vm(["running"]);
		expect(await wakeForFinalize(deps)).toEqual({
			ok: true,
			resumed: false,
			from: "running",
		});
		expect(deps.resume).not.toHaveBeenCalled();
		expect(deps.hold).toHaveBeenCalledOnce();
	});

	it("resumes a paused VM before staging", async () => {
		const deps = vm(["paused", "running"]);
		expect(await wakeForFinalize(deps)).toEqual({
			ok: true,
			resumed: true,
			from: "paused",
		});
		expect(deps.resume).toHaveBeenCalledOnce();
		expect(deps.hold).toHaveBeenCalledOnce();
	});

	it("retries a failed resume, then succeeds", async () => {
		// Still paused after the failed resume; running after the second.
		const deps = vm(["paused", "paused", "running"]);
		deps.resume.mockRejectedValueOnce(new Error("provider 503"));
		const result = await wakeForFinalize(deps);
		expect(result).toMatchObject({ ok: true, resumed: true });
		expect(deps.resume).toHaveBeenCalledTimes(2);
		expect(deps.sleep).toHaveBeenCalledOnce();
	});

	it("reports a deleted or expired VM as gone without throwing", async () => {
		const deps = vm([null]);
		expect(await wakeForFinalize(deps)).toMatchObject({
			ok: false,
			gone: true,
		});
		expect(deps.resume).not.toHaveBeenCalled();
	});

	it("gives up after its tries with the last error", async () => {
		const deps = vm(["paused"]);
		deps.resume.mockRejectedValue(new Error("budget spent"));
		const result = await wakeForFinalize(deps, 3);
		expect(result).toMatchObject({ ok: false, gone: false });
		expect(result.ok ? "" : result.reason).toContain("budget spent");
		expect(deps.resume).toHaveBeenCalledTimes(3);
	});

	it("does not fail a wake when the idle hold is refused", async () => {
		const deps = vm(["running"]);
		deps.hold.mockRejectedValue(new Error("no"));
		expect(await wakeForFinalize(deps)).toMatchObject({ ok: true });
	});
});

const call = (tool: string, extra: Partial<SessionItem> = {}): SessionItem =>
	({
		kind: "dynamicToolCall",
		id: SessionItemId(`${tool}-${Math.random()}`),
		tool,
		status: "completed",
		...extra,
	}) as SessionItem;

describe("hard set tool-call record", () => {
	it("counts tools per name, run_code's inner calls and the model's calls", () => {
		const items: SessionItem[] = [
			call("bash"),
			call("bash", { status: "failed" } as Partial<SessionItem>),
			call("find_tools"),
			call("agent"),
			call("run_code", {
				output: JSON.stringify({
					ok: true,
					calls: [
						{ tool: "bash", input: "", status: "completed", ms: 1, output: "" },
						{ tool: "read", input: "", status: "completed", ms: 1, output: "" },
						{ tool: "bash", input: "", status: "failed", ms: 1, output: "" },
					],
				}),
			} as Partial<SessionItem>),
			{ kind: "agentMessage", id: SessionItemId("m"), text: "done" } as never,
		];
		const messages = [
			{ role: "user", content: "task" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "x" },
					{ type: "tool-call", toolName: "bash" },
					{ type: "tool-call", toolName: "agent" },
				],
			},
			{ type: "function_call", name: "find_tools" },
		];
		const summary = toolCallSummary(items, messages);
		expect(summary.total).toBe(5);
		expect(summary.byTool).toEqual({
			bash: 2,
			find_tools: 1,
			agent: 1,
			run_code: 1,
		});
		expect(summary.failedByTool).toEqual({ bash: 1 });
		expect(summary.runCode).toEqual({
			programs: 1,
			innerByTool: { bash: 2, read: 1 },
		});
		expect(summary.modelByTool).toEqual({ bash: 1, agent: 1, find_tools: 1 });
		const line = toolCallLine(summary);
		expect(line).toContain("5 call(s): bash 2");
		expect(line).toContain("[agent 1, find_tools 1, run_code 1]");
		expect(line).toContain("run_code inner: bash 2, read 1");
	});

	it("shows the watched tools at zero when a run never used them", () => {
		const line = toolCallLine(toolCallSummary([call("bash")], null));
		expect(line).toBe("1 call(s): bash 1 [agent 0, find_tools 0, run_code 0]");
		expect(toolCallLine(null)).toBe("no tool-call record");
	});
});

describe("hard set report: review=on runs without a loop record", () => {
	it("says whether review never ran or its state was not kept", () => {
		const lines = reviewLoopReport([
			{
				task: "a",
				attempt: "1",
				status: "error",
				passed: false,
				variant: "review=on",
				loopStates: { review: [] },
			},
			{
				task: "b",
				attempt: "1",
				status: "error",
				passed: false,
				variant: "review=on",
			},
			{
				task: "c",
				attempt: "1",
				status: "final",
				passed: true,
				variant: "default",
			},
		]);
		expect(lines.join("\n")).toContain("a.1: review=on but no review loop ran");
		expect(lines.join("\n")).toContain("b.1: review=on; no review-loop state");
		expect(lines.join("\n")).not.toContain("c.1");
	});
});
