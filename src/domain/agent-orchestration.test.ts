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
