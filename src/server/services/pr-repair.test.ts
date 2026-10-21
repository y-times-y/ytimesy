import { afterEach, expect, it, vi } from "vitest";
import { deliverPrRepairEvents } from "./pr-repair";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({ wakes: vi.fn() }));
vi.mock("./pull-request-wake", () => ({
	deliverPullRequestWakes: mocks.wakes,
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

it("delivers pull request wake-ups only when PR repair is enabled", async () => {
	const machines = {} as WorkspaceMachines;
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "0");
	await deliverPrRepairEvents(machines);
	expect(mocks.wakes).not.toHaveBeenCalled();
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	await deliverPrRepairEvents(machines);
	expect(mocks.wakes).toHaveBeenCalledWith(machines);
});
