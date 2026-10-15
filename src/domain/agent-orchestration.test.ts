import { expect, it } from "vitest";
import {
	agentSessionRoleInstructions,
	cloudAgentRoleInstructions,
} from "./agent-orchestration";

it("makes the root chat the builder, in plain words", () => {
	const direct = cloudAgentRoleInstructions({}, { shellBuilder: true });
	expect(direct).toContain("work directly in this workspace");
	expect(direct).toContain("genuinely theirs");
	expect(direct).not.toContain("pinned-baseline");
	expect(direct).not.toContain("no delegation");
	expect(direct).not.toContain("read-only lead");
	expect(direct).not.toContain("create_task");
});

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

it("requires executable original-contract boundary evidence from children", () => {
	const instructions = cloudAgentRoleInstructions({
		parentSessionId: "lead",
		taskAccess: "read_write",
	});
	expect(instructions).toContain("retained executable evidence");
	expect(instructions).toContain("original contract, not the implementation");
	expect(instructions).toContain("first handoff");
	expect(instructions).toContain("Inspect those results before acceptance");
});

it("keeps child role prompts concise without weakening verification", () => {
	const builder = cloudAgentRoleInstructions({
		parentSessionId: "lead",
		taskAccess: "read_write",
	});
	expect(builder).toContain("Implement your own bounded task directly");
	expect(builder).not.toContain("start at least one fresh read-write child");
	expect(builder).toContain("repository-required preflight takes precedence");
	expect(builder).toContain("read_task_capacity");
	expect(builder.length).toBeLessThan(3500);
});

it("distinguishes writable and read-only children", () => {
	const writable = agentSessionRoleInstructions({ taskAccess: "read_write" });
	expect(writable).toContain("Implement your own bounded task directly");
	expect(writable).not.toContain("end this turn");
	expect(agentSessionRoleInstructions({ taskAccess: "read_only" })).toContain(
		"do not edit files",
	);
});

it("requires stable final verification without redundant baseline runs", () => {
	const prompt = cloudAgentRoleInstructions({
		parentSessionId: "lead",
		taskAccess: "read_write",
	});
	expect(prompt.toLowerCase()).toContain("baseline");
	expect(prompt).toContain("repository policy requires it");
	expect(prompt).toContain("stable");
	expect(prompt).toContain("semicolon-separated");
	expect(prompt).toContain("project-configured formatting");
});

it("gives shell builders a short role without specialist-tool instructions", () => {
	const shell = cloudAgentRoleInstructions(
		{ parentSessionId: "lead", taskAccess: "read_write" },
		{ shellBuilder: true },
	);
	expect(shell).toContain("Implement your own bounded task directly");
	expect(shell).toContain("report_task_blocked");
	expect(shell).not.toMatch(
		/run_checks|apply_patches|batch_read|inspect_changes/,
	);
	expect(shell.length).toBeLessThan(1500);
});
