import { expect, it } from "vitest";
import { cloudAgentRoleInstructions } from "./agent-orchestration";

it("makes the root chat the builder, in plain words", () => {
	const direct = cloudAgentRoleInstructions();
	expect(direct).toContain("work directly in this workspace");
	expect(direct).toContain("genuinely theirs");
	expect(direct).not.toContain("pinned-baseline");
	expect(direct).not.toContain("no delegation");
	expect(direct).not.toContain("read-only lead");
	expect(direct).not.toContain("create_task");
});

it("softens the root line only when the builder can delegate", () => {
	const delegating = cloudAgentRoleInstructions({ delegates: true });
	expect(delegating).toContain(
		"work in this workspace. Inspect, implement, run the checks and answer the user yourself, delegating only as below.",
	);
	expect(delegating).not.toContain("work directly");
	expect(cloudAgentRoleInstructions()).toContain("work directly");
});

it("adds the check-in-proportion rule only when asked", () => {
	const on = cloudAgentRoleInstructions({
		unattended: true,
		checkInProportion: true,
	});
	const off = cloudAgentRoleInstructions({ unattended: true });
	expect(on).toContain("Check in proportion");
	expect(off).not.toContain("Check in proportion");
	expect(off).toContain("Your final answer is brief");
});
