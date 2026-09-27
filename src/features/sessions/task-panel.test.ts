import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentTask } from "#/domain/agent-task";
import { TaskPanel } from "./task-panel";

it("shows task hierarchy and statuses without interactive controls", () => {
	const base: AgentTask = {
		id: "task",
		parentSessionId: "root",
		title: "Inspect the source",
		label: "Task 1",
		depth: 1,
		status: "done",
		prompt: "Private task prompt",
		placement: "fresh",
		access: "read_write",
		execution: "parallel",
		dependsOnSessionId: null,
		summary: null,
		reviewState: "pending",
		branch: null,
		pullRequestUrl: null,
		harnessId: "codex",
		listedModelId: "Test model",
		createdAt: "",
		updatedAt: "",
	};
	const html = renderToStaticMarkup(
		createElement(TaskPanel, {
			tasks: [
				base,
				{
					...base,
					id: "child",
					label: "Task 1.1",
					depth: 2,
					status: "working",
				},
			],
		}),
	);
	expect(html).toContain("Task 1.1");
	expect(html).toContain("1/2 completed");
	expect(html).toContain("Test model");
	expect(html).toContain('aria-label="Working"');
	expect(html).not.toMatch(/<(button|input|select|textarea|details|a)\b/);
	expect(html).not.toContain("Private task prompt");
	expect(html).not.toContain("fresh");
});

it("explains that tasks are agent-created when empty", () => {
	const html = renderToStaticMarkup(createElement(TaskPanel, { tasks: [] }));
	expect(html).toContain("when the agent creates tasks");
	expect(html).not.toContain("New task");
});
