import { describe, expect, it } from "vitest";
import {
	AGENT_ORCHESTRATION_INSTRUCTIONS,
	agentSessionRoleInstructions,
	cloudAgentRoleInstructions,
} from "./agent-orchestration";

it("permits only proven check-generated cleanup without expanding child ownership", () => {
	const builder = cloudAgentRoleInstructions({
		parentSessionId: "lead",
		taskAccess: "read_write",
	});
	expect(builder).toContain("generated-only artifacts from your own checks");
	expect(builder).toContain("clean before the check");
	expect(builder).toContain("exclusive checkout");
	expect(builder).toContain("preserve pre-existing edits");
	expect(builder).toContain("Otherwise report the scope question");
});

it("batches independent ready calls without batching evidence-dependent decisions", () => {
	const lead = cloudAgentRoleInstructions({});
	expect(lead).toContain("Use launch_ready_tasks for independent contracts");
	expect(lead).toContain("Use batch_read for independent reads");
	expect(lead).toContain("never batch dependent evidence or decisions");
});

it("prepares contract-based review while builders work and rejects stricter validation", () => {
	const lead = cloudAgentRoleInstructions({});
	expect(lead).toContain("while builders work");
	expect(lead).toContain("allowed inputs adjacent to forbidden cases");
	expect(lead).toContain("a stronger validation rule is a correctness bug");
	expect(lead).toContain("ORIGINAL user contract");
	expect(lead).toContain("reproduced failure before requesting repair");
	expect(lead).toContain("one bounded diagnostic");
});

it("requires executable original-contract boundary evidence from both roles", () => {
	for (const instructions of [
		AGENT_ORCHESTRATION_INSTRUCTIONS,
		cloudAgentRoleInstructions({}),
		cloudAgentRoleInstructions({
			parentSessionId: "lead",
			taskAccess: "read_write",
		}),
	]) {
		expect(instructions).toContain("retained executable evidence");
		expect(instructions).toContain("original contract, not the implementation");
		expect(instructions).toContain("first handoff");
		expect(instructions).toContain("Inspect those results before acceptance");
	}
});

it("compares independent deliverables on the complete critical path without folder bias", () => {
	for (const lead of [
		cloudAgentRoleInstructions({}),
		agentSessionRoleInstructions({}),
	]) {
		expect(lead).not.toContain("default to concurrent owners");
		expect(lead).toContain("one coherent builder");
		expect(lead).toContain("eligible for concurrent owners within capacity");
		expect(lead).toContain("do not dismiss testing as trivial generation");
		expect(lead).not.toContain("bounded same-subsystem change");
		expect(lead).toContain("additional orientation, review and integration");
		expect(lead).toContain("complete verification ownership");
		expect(lead).toContain("review early finishers while others run");
	}
});

it("keeps cloud role prompts concise without weakening delegation or verification", () => {
	const lead = cloudAgentRoleInstructions({});
	const builder = cloudAgentRoleInstructions({
		parentSessionId: "lead",
		taskAccess: "read_write",
	});
	expect(lead).toContain("start at least one fresh read-write child");
	expect(lead.length).toBeLessThan(6500);
	expect(lead.length).toBeLessThan(AGENT_ORCHESTRATION_INSTRUCTIONS.length / 2);
	expect(builder).toContain("Implement your own bounded task directly");
	expect(builder).not.toContain("start at least one fresh read-write child");
	expect(builder).toContain("repository-required preflight takes precedence");
	expect(builder).toContain("read_task_capacity");
	expect(builder.length).toBeLessThan(lead.length / 2);
});

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

it("requires stable final verification without redundant baseline runs", () => {
	for (const prompt of [
		cloudAgentRoleInstructions({}),
		cloudAgentRoleInstructions({
			parentSessionId: "lead",
			taskAccess: "read_write",
		}),
	]) {
		expect(prompt.toLowerCase()).toContain("baseline");
		expect(prompt).toContain("repository policy requires it");
		expect(prompt).toContain("stable");
		expect(prompt).toContain("semicolon-separated");
	}
	expect(
		cloudAgentRoleInstructions({
			parentSessionId: "lead",
			taskAccess: "read_write",
		}),
	).toContain("project-configured formatting");
});

it("compares coordination cost and gives a sole builder complete verification ownership", () => {
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"Independent signatures alone do not justify duplicating mandatory orientation",
	);
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"Preserve every exact acceptance condition and all tests",
	);
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("parallel critical path");
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("longest builder path");
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"boundary-test generation",
	);
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"complete final project verification",
	);
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"eligible for concurrent owners within capacity",
	);
	expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
		"Never skip required reading or verification",
	);
});

describe("agent orchestration policy", () => {
	it("requires exact reviewed-patch integration in a writable child, not a writable lead", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"integrate_reviewed_tasks",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"fresh writable integration draft",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"The lead remains read-only",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"If imports conflict, verification fails",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("same checkout");
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"without model inference",
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
				"Do not serialize useful independent work behind an unnecessary predecessor",
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
