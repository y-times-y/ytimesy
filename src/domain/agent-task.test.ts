import { describe, expect, it } from "vitest";
import {
	agentTaskStartBlockedByDependency,
	agentTaskStatusReceipt,
	agentTaskSummaryPage,
	agentTaskTree,
	canSpawnAgentTask,
	MAX_AGENT_TASK_DEPTH,
	validateAgentTaskPlan,
} from "./agent-task";

it("pages complete recorded summaries without splitting Unicode or implying verification", () => {
	const summary = `${"🙂".repeat(4001)} retained-output-reference`;
	const first = agentTaskSummaryPage(summary);
	expect(first).toEqual({
		content: "🙂".repeat(4000),
		start: 0,
		nextStart: 4000,
	});
	expect(agentTaskSummaryPage(summary, first.nextStart)).toEqual({
		content: "🙂 retained-output-reference",
		start: 4000,
		nextStart: null,
	});
	expect(agentTaskSummaryPage(null)).toEqual({
		content: "",
		start: 0,
		nextStart: null,
	});
	for (const start of [-1, 0.5, NaN, Infinity, "0", null, 32_000_001])
		expect(() => agentTaskSummaryPage(summary, start)).toThrow("Summary start");
});

describe("agentTaskTree", () => {
	it("omits assignments from status receipts unless explicitly requested", () => {
		const [task] = agentTaskTree("root", [
			{
				id: "child",
				parentSessionId: "root",
				title: "Implement bounded change",
				taskPrompt: "Exact original contract",
				turnStatus: "completed",
				harness: "codex",
				listedModelId: "model",
				createdAt: "2026-09-21T12:01:00.000Z",
				updatedAt: "2026-09-21T12:01:00.000Z",
			},
		]);
		expect(agentTaskStatusReceipt(task)).not.toHaveProperty("prompt");
		expect(agentTaskStatusReceipt(task)).toMatchObject({
			id: task.id,
			status: "done",
			title: task.title,
		});
		expect(agentTaskStatusReceipt(task, true)).toBe(task);
		expect(task.prompt).toBe("Exact original contract");
	});
	it("numbers recursive tasks by their position under each parent", () => {
		const tasks = agentTaskTree("root", [
			{
				id: "child-2",
				parentSessionId: "root",
				title: "Tests",
				turnStatus: "idle",
				harness: "codex",
				listedModelId: "codex/model",
				createdAt: "2026-09-21T12:01:00.000Z",
				updatedAt: "2026-09-21T12:01:00.000Z",
			},
			{
				id: "grandchild",
				parentSessionId: "child-1",
				title: "Adapters",
				turnStatus: "running",
				harness: "codex",
				listedModelId: null,
				createdAt: "2026-09-21T12:02:00.000Z",
				updatedAt: "2026-09-21T12:02:00.000Z",
			},
			{
				id: "child-1",
				parentSessionId: "root",
				title: "Audit",
				turnStatus: "completed",
				harness: "codex",
				listedModelId: null,
				createdAt: "2026-09-21T12:00:00.000Z",
				updatedAt: "2026-09-21T12:03:00.000Z",
			},
		]);

		expect(
			tasks.map(({ label, title, depth, status }) => ({
				label,
				title,
				depth,
				status,
			})),
		).toEqual([
			{ label: "Task 1", title: "Audit", depth: 1, status: "done" },
			{
				label: "Task 1.1",
				title: "Adapters",
				depth: 2,
				status: "working",
			},
			{ label: "Task 2", title: "Tests", depth: 1, status: "idle" },
		]);
	});
});

describe("canSpawnAgentTask", () => {
	it("caps recursive delegation at three task levels", () => {
		expect(canSpawnAgentTask(MAX_AGENT_TASK_DEPTH - 1)).toBe(true);
		expect(canSpawnAgentTask(MAX_AGENT_TASK_DEPTH)).toBe(false);
	});
});

describe("validateAgentTaskPlan", () => {
	it("keeps shared machines read-only", () => {
		expect(
			validateAgentTaskPlan({
				prompt: "Implement the change",
				placement: "shared",
				access: "read_write",
				execution: "parallel",
				dependsOnSessionId: null,
			}),
		).toBe("Shared-machine tasks must be read-only.");
	});

	it("requires an explicit predecessor only for stacked work", () => {
		expect(
			validateAgentTaskPlan({
				prompt: "Continue the migration",
				placement: "fresh",
				access: "read_write",
				execution: "stacked",
				dependsOnSessionId: null,
			}),
		).toBe("Stacked tasks require a predecessor.");
		expect(
			validateAgentTaskPlan({
				prompt: "Audit the API",
				placement: "shared",
				access: "read_only",
				execution: "parallel",
				dependsOnSessionId: null,
			}),
		).toBeNull();
	});
});

describe("agentTaskStartBlockedByDependency", () => {
	it("requires a completed and reviewed predecessor", () => {
		const task = {
			execution: "stacked" as const,
			dependsOnSessionId: "task-1",
		};
		expect(
			agentTaskStartBlockedByDependency(task, {
				status: "working",
				reviewState: "pending",
				branch: null,
			}),
		).toContain("finish");
		expect(
			agentTaskStartBlockedByDependency(task, {
				status: "done",
				reviewState: "pending",
				branch: null,
			}),
		).toContain("Review");
		expect(
			agentTaskStartBlockedByDependency(task, {
				status: "done",
				reviewState: "reviewed",
				branch: null,
			}),
		).toContain("Publish");
		expect(
			agentTaskStartBlockedByDependency(task, {
				status: "done",
				reviewState: "reviewed",
				branch: "task-1",
			}),
		).toBeNull();
	});
});
