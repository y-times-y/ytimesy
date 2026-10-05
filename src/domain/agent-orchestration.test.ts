import { describe, expect, it } from "vitest";
import {
	AGENT_ORCHESTRATION_INSTRUCTIONS,
	agentSessionRoleInstructions,
} from "./agent-orchestration";

it("distinguishes the root lead from writable and read-only children", () => {
	expect(agentSessionRoleInstructions({})).toContain("read-only lead");
	expect(
		agentSessionRoleInstructions({
			parentSessionId: "parent",
			taskAccess: "read_write",
		}),
	).toContain("Implement your own bounded task directly");
	expect(
		agentSessionRoleInstructions({
			parentSessionId: "parent",
			taskAccess: "read_only",
		}),
	).toContain("do not edit files");
});

describe("agent orchestration policy", () => {
	it("requires exact reviewed-patch integration in a writable child, not a writable lead", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("import_reviewed_task");
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"fresh writable integration child",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"The lead remains read-only",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"fail visibly on conflicts",
		);
	});
	it("requires ready independent workstreams to launch before waiting", () => {
		for (const instructions of [
			AGENT_ORCHESTRATION_INSTRUCTIONS,
			agentSessionRoleInstructions({}),
		]) {
			expect(instructions).toContain(
				"file ownership, shared interfaces, and dependencies",
			);
			expect(instructions).toContain(
				"start the ready workstreams in the same turn, before waiting",
			);
			expect(instructions).toContain(
				"Do not default to one builder for a multi-workstream task",
			);
			expect(instructions).toContain(
				"Agree shared interfaces in the child prompts before launch",
			);
			expect(instructions).toContain("available capacity permits only one");
			expect(instructions).toContain("state the concrete reason");
			expect(instructions).toContain("Do not split trivial edits");
			expect(instructions).toContain("Preserve repository-required preflight");
			expect(instructions).toContain(
				"do not perform every builder's full implementation investigation before launching it",
			);
			expect(instructions).toContain("Delegate deeper reuse checks");
			expect(instructions).toContain(
				"requiring evidence before custom logic or acceptance",
			);
		}
	});

	it("does not impose the root decomposition policy on a bounded builder", () => {
		expect(
			agentSessionRoleInstructions({
				parentSessionId: "lead",
				taskAccess: "read_write",
			}),
		).not.toContain("Do not default to one builder");
	});

	it("yields idle leads for durable completion wakeups without making builders yield", () => {
		const lead = agentSessionRoleInstructions({});
		expect(lead).toContain(
			"Durable child-completion notifications will wake you",
		);
		expect(lead).toContain("Do not repeatedly call list_tasks");
		expect(
			agentSessionRoleInstructions({
				parentSessionId: "lead",
				taskAccess: "read_write",
			}),
		).not.toContain("end this turn");
	});
	it("starts authorized implementation without a redundant delegation question", () => {
		for (const instructions of [
			AGENT_ORCHESTRATION_INSTRUCTIONS,
			agentSessionRoleInstructions({}),
		]) {
			expect(instructions).toContain("in the same turn");
			expect(instructions).toContain("do not ask whether to create a child");
			expect(instructions).toContain(
				"authorization beyond the requested scope",
			);
			expect(instructions).toContain(
				"wait, plan only, or avoid implementation",
			);
			expect(instructions).toContain(
				"report-only requests without starting writing children",
			);
		}
	});

	it("preserves parallel writers and direct implementation by builders", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"Run disjoint writers in parallel",
		);
		const builder = agentSessionRoleInstructions({
			parentSessionId: "parent",
			taskAccess: "read_write",
		});
		expect(builder).toContain("Implement your own bounded task directly");
		expect(builder).not.toContain("draft and start at least one");
	});

	it("teaches leads to parallelize selectively and synthesize verified results", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"continue useful read-only investigation",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("request_task_wrap_up");
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"verify important child claims",
		);
	});

	it("requires a fresh writing child for code changes while keeping simple answers local", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"answer simple questions directly",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"fresh read-write child task",
		);
	});

	it("lets the lead choose task count from real decomposition", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"smallest coherent decomposition",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"runtime capacity errors",
		);
	});
});
