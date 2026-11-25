import { beforeEach, expect, it, vi } from "vitest";

const resolve = vi.fn();
const dispatch = vi.fn();
vi.mock("./environment-build", () => ({
	recoverExpiredEnvironmentBuilds: vi.fn(),
	resolveEnvironmentBuildInput: (...args: unknown[]) => resolve(...args),
}));
vi.mock("../adapters/workspaces", () => ({
	listReadyWorkspaceIds: async () => ["w-same", "w-changed", "w-broken"],
}));
vi.mock("../adapters/background-job-dispatch", () => ({
	backgroundJobId: (key: string) => key,
	dispatchBackgroundJob: (job: unknown) => dispatch(job),
}));

import { deliverBackgroundJob } from "./background-job-delivery";

beforeEach(() => {
	resolve.mockReset();
	dispatch.mockReset();
});

it("refreshes only workspaces whose build inputs changed, and still dispatches when the check fails", async () => {
	resolve.mockImplementation(async (workspaceId: string) => {
		if (workspaceId === "w-same") return null;
		if (workspaceId === "w-broken") throw new Error("token revoked");
		return { inputHash: "new" };
	});
	await deliverBackgroundJob(
		{} as never,
		{
			id: "cron:1:refresh",
			kind: "maintenance",
			action: "refresh",
		} as never,
	);
	expect(dispatch.mock.calls.map(([job]) => job.workspaceId)).toEqual([
		"w-changed",
		"w-broken",
	]);
	expect(resolve).toHaveBeenCalledTimes(3);
});
