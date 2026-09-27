import { describe, expect, it } from "vitest";
import {
	agentTaskStartBlockedByDependency,
	agentTaskTree,
	canSpawnAgentTask,
	MAX_AGENT_TASK_DEPTH,
	validateAgentTaskPlan,
} from "./agent-task";

describe("agentTaskTree", () => {
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
