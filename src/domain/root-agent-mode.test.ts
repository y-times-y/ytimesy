import { expect, it } from "vitest";
import { cloudAgentRoleInstructions } from "./agent-orchestration";
import { rootAgentMode } from "./root-agent-mode";

it("makes the root chat the builder by default, with a lead only when chosen", () => {
	expect(rootAgentMode(undefined)).toBe("builder");
	expect(rootAgentMode("")).toBe("builder");
	expect(rootAgentMode("lead")).toBe("lead");
	const direct = cloudAgentRoleInstructions(
		{},
		{ shellBuilder: true, direct: true },
	);
	expect(direct).toContain("work directly in this workspace");
	expect(direct).not.toContain("read-only lead");
	expect(direct).not.toContain("create_task");
	expect(cloudAgentRoleInstructions({})).toContain("read-only lead");
});
