import { describe, expect, it } from "vitest";
import { AGENT_ORCHESTRATION_INSTRUCTIONS } from "./agent-orchestration";

describe("agent orchestration policy", () => {
	it("teaches leads to parallelize selectively and synthesize verified results", () => {
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"continue useful work yourself",
		);
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain("request_task_wrap_up");
		expect(AGENT_ORCHESTRATION_INSTRUCTIONS).toContain(
			"verify important child claims",
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
