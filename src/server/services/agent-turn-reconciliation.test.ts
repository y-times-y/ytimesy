import { describe, expect, it, vi } from "vitest";
import { reconcileRunningAgentTurns } from "./agent-turn-reconciliation";
import type { HarnessSessionScope } from "./harness-workspace-session";
import type { WorkspaceMachines } from "./workspace-machines";

describe("running turn reconciliation", () => {
	it("observes each persisted running session despite one provider failure", async () => {
		const machines = {} as WorkspaceMachines;
		const observe = vi.fn(async (_machines: WorkspaceMachines, scope: HarnessSessionScope) => {
			if (scope.sessionId === "first") throw new Error("VM temporarily unavailable");
		});
		const result = await reconcileRunningAgentTurns(machines, {
			list: async () => [
				{
					id: "first",
					userId: "user",
					projectId: "project",
					harness: "codex",
					taskPlacement: "fresh",
				},
				{
					id: "second",
					userId: "user",
					projectId: "project",
					harness: "claude",
					taskPlacement: "fresh",
				},
			],
			observe,
		});
		expect(result).toEqual({ observed: 1, failed: 1 });
		expect(observe).toHaveBeenCalledTimes(2);
	});
});
