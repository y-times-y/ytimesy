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
		summary: null,
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
	// Short names and icon colours as the agents list gives them, in start order.
	expect(html).toContain("<strong>build-1</strong>");
	expect(html).toContain("<strong>build-2</strong>");
	expect(html).toContain('style="color:#FF8F96"');
	expect(html).toContain("Subagents <span");
	expect(html).not.toContain("Task 1");
	expect(html).toContain("1/2 completed");
	expect(html).toContain("Test model");
	expect(html).toContain('aria-label="Working"');
	expect(html).not.toMatch(/<(button|input|select|textarea|details|a)\b/);
	expect(html).not.toContain("Private task prompt");
	expect(html).not.toContain("fresh");
});

it("explains that subagents appear once started when empty", () => {
	const html = renderToStaticMarkup(createElement(TaskPanel, { tasks: [] }));
	expect(html).toContain("Subagents appear here when Main starts them.");
	expect(html).not.toContain("New task");
});

it("shows each subagent's role, VM, budget use and spend, and the tree total", () => {
	const spend = (tokens: number, costUsd: number, vmMinutes = 0) => ({
		tokens,
		budgetTokens: tokens,
		inputTokens: tokens,
		outputTokens: 0,
		cacheReadTokens: 0,
		costUsd,
		planBilled: false,
		vmMinutes,
	});
	const task: AgentTask = {
		id: "w",
		parentSessionId: "root",
		title: "Add the flag",
		label: "Task 1",
		depth: 1,
		status: "working",
		prompt: "Private brief",
		placement: "fresh",
		access: "read_write",
		summary: null,
		harnessId: "api",
		listedModelId: "Sonnet",
		createdAt: "",
		updatedAt: "",
	};
	const html = renderToStaticMarkup(
		createElement(TaskPanel, {
			tasks: [
				{
					...task,
					subagent: {
						role: "writer",
						vm: "fork",
						steps: 41,
						minutes: 6.2,
						budget: { steps: 150, minutes: 30, tokens: 2_000_000 },
						spend: spend(380_000, 0.76, 9),
						subtree: spend(480_000, 0.96, 9),
					},
				},
				{
					...task,
					id: "r",
					label: "Task 1.1",
					depth: 2,
					status: "done",
					subagent: {
						role: "reviewer",
						vm: "shared",
						steps: 7,
						minutes: 2,
						budget: null,
						spend: spend(100_000, 0.2),
						subtree: spend(100_000, 0.2),
					},
				},
			],
		}),
	);
	expect(html).toContain(
		"writer · fork · 41/150 steps · 6/30 min · 480k tok · $0.96 · 9.0 VM min",
	);
	expect(html).toContain(
		"reviewer · shared · 7 steps · 2 min · 100k tok · $0.20",
	);
	expect(html).toContain("Subagents 2 · 480k tok · $0.96 · 9.0 VM min");
	expect(html).not.toContain("Private brief");
	expect(html).not.toMatch(/<(button|input|select|textarea|details|a)\b/);
});
