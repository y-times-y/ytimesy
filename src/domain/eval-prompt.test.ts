import { expect, it } from "vitest";
import { evalWorkSuffix } from "./eval-prompt";

it("keeps the no-plan/commit/PR/publish rules and never mentions child tasks", () => {
	for (const subagents of [false, true]) {
		const suffix = evalWorkSuffix({
			where: "environment",
			done: "task",
			subagents,
		});
		expect(suffix).toContain(
			"no plan proposal, commits, pull requests or publishing",
		);
		expect(suffix).not.toContain("child tasks");
		expect(suffix).toContain("Stop when the task is done and checked.");
	}
});

it("forbids nothing about delegation when subagents are on", () => {
	expect(
		evalWorkSuffix({ where: "environment", done: "task", subagents: false }),
	).toBe(
		"\n\nWork directly in this environment: no plan proposal, commits, pull requests or publishing. Stop when the task is done and checked.",
	);
	const on = evalWorkSuffix({
		where: "repository",
		done: "change",
		subagents: true,
	});
	expect(on).toBe(
		"\n\nWork in this repository: no plan proposal, commits, pull requests or publishing. Stop when the change is done and checked.",
	);
	expect(on).not.toMatch(/directly|delegat|subagent/);
});
