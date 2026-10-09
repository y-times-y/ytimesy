import { afterEach, expect, it, vi } from "vitest";

const build = vi.hoisted(() => ({
	resolveEnvironmentBuildInput: vi.fn(),
	claimEnvironmentBuild: vi.fn(),
	provisionEnvironmentBuild: vi.fn(),
	prepareEnvironmentRepositories: vi.fn(),
	verifyEnvironmentRepositories: vi.fn(),
	activateEnvironmentBuild: vi.fn(),
	finishEnvironmentBuild: vi.fn(),
	failEnvironmentPreflight: vi.fn(),
	assertDistinctEnvironmentServicePorts: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		constructor(
			_context: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../src/server/adapters/database-scope", () => ({
	withDatabaseScope: async (_url: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/services/environment-build", () => build);

import { ProjectEnvironmentWorkflow } from "../src/server/edge/environment-workflow";

const workspaceId = "00000000-0000-4000-8000-000000000002";

function fixture() {
	const workflow = new ProjectEnvironmentWorkflow(
		{} as never,
		{
			DATABASE_URL: "fixture",
			HYPERDRIVE: { connectionString: "fixture" },
			YTIMESY_GIT_PROXY_URL: "https://fixture.invalid",
			YTIMESY_GIT_PROXY_SECRET: "x".repeat(32),
		} as never,
	);
	const step = {
		do: vi.fn(async (_name, options, run) => {
			for (let attempt = 0; ; attempt++) {
				try {
					return await run();
				} catch (error) {
					if (attempt >= options.retries.limit) throw error;
				}
			}
		}),
	};
	const event = {
		payload: {
			requestId: "00000000-0000-4000-8000-000000000001",
			workspaceId,
			force: false,
			repairModel: null,
		},
	};
	build.resolveEnvironmentBuildInput.mockResolvedValue({
		workspaceId,
		repositories: [{ fullName: "org/repo" }],
	});
	build.claimEnvironmentBuild.mockResolvedValue("build");
	build.provisionEnvironmentBuild.mockResolvedValue("vm");
	build.prepareEnvironmentRepositories.mockResolvedValue([]);
	build.verifyEnvironmentRepositories.mockResolvedValue([]);
	build.activateEnvironmentBuild.mockResolvedValue("snapshot");
	build.finishEnvironmentBuild.mockResolvedValue(undefined);
	return {
		workflow,
		step,
		event,
		run: () => workflow.run(event as never, step as never),
	};
}
afterEach(() => vi.resetAllMocks());

it("records each repository installation independently and checks shared ports before activation", async () => {
	const { run, step } = fixture();
	build.resolveEnvironmentBuildInput.mockResolvedValue({
		workspaceId,
		repositories: [{ fullName: "org/web" }, { fullName: "org/api" }],
	});
	build.prepareEnvironmentRepositories.mockImplementation(
		async (input) => input.repositories,
	);
	await run();
	expect(step.do.mock.calls.map((call) => call[0])).toContain(
		"checkout-and-install-0",
	);
	expect(step.do.mock.calls.map((call) => call[0])).toContain(
		"checkout-and-install-1",
	);
	expect(build.assertDistinctEnvironmentServicePorts).toHaveBeenCalledWith([
		{ fullName: "org/web" },
		{ fullName: "org/api" },
	]);
});

it("does not activate an environment whose repositories collide on service ports", async () => {
	const { run } = fixture();
	build.assertDistinctEnvironmentServicePorts.mockImplementation(() => {
		throw new Error("service ports overlap");
	});
	await expect(run()).rejects.toThrow("service ports overlap");
	expect(build.activateEnvironmentBuild).not.toHaveBeenCalled();
	expect(build.finishEnvironmentBuild).toHaveBeenCalledOnce();
});

it("retries transient cleanup without replaying installation or activation", async () => {
	const { run, step } = fixture();
	build.finishEnvironmentBuild.mockRejectedValueOnce(
		new Error("pause unavailable"),
	);
	expect(await run()).toEqual({ outcome: "ready", snapshotId: "snapshot" });
	expect(build.finishEnvironmentBuild).toHaveBeenCalledTimes(2);
	expect(build.prepareEnvironmentRepositories).toHaveBeenCalledTimes(1);
	expect(build.activateEnvironmentBuild).toHaveBeenCalledTimes(1);
	const cleanup = step.do.mock.calls.find(
		(call) => call[0] === "finish-and-pause",
	);
	expect(cleanup?.[1].retries.limit).toBe(3);
	expect(
		step.do.mock.calls
			.filter((call) => call[0] !== "finish-and-pause")
			.every((call) => call[1].retries.limit === 0),
	).toBe(true);
});

it("cleans up a failed installation without activating or replaying it", async () => {
	const { run } = fixture();
	build.prepareEnvironmentRepositories.mockRejectedValue(
		new Error("install failed"),
	);
	await expect(run()).rejects.toThrow("install failed");
	expect(build.prepareEnvironmentRepositories).toHaveBeenCalledTimes(1);
	expect(build.activateEnvironmentBuild).not.toHaveBeenCalled();
	expect(build.finishEnvironmentBuild).toHaveBeenCalledWith(
		{ workspaceId, repositories: [{ fullName: "org/repo" }] },
		"build",
		expect.objectContaining({ exec: expect.any(Function) }),
	);
});

it("fails visibly when cleanup exhausts its retries", async () => {
	const { run } = fixture();
	build.finishEnvironmentBuild.mockRejectedValue(
		new Error("pause unavailable"),
	);
	await expect(run()).rejects.toThrow("pause unavailable");
	expect(build.finishEnvironmentBuild).toHaveBeenCalledTimes(4);
	expect(build.provisionEnvironmentBuild).toHaveBeenCalledTimes(1);
});

it("does not touch a VM for an unchanged environment", async () => {
	const { run } = fixture();
	build.resolveEnvironmentBuildInput.mockResolvedValue(null);
	expect(await run()).toEqual({ outcome: "unchanged" });
	expect(build.claimEnvironmentBuild).not.toHaveBeenCalled();
	expect(build.finishEnvironmentBuild).not.toHaveBeenCalled();
});

it("records preflight failure without claiming a build", async () => {
	const { run } = fixture();
	build.resolveEnvironmentBuildInput.mockRejectedValue(
		new Error("private diagnostic"),
	);
	await expect(run()).rejects.toThrow(
		"Environment source authorization failed.",
	);
	expect(build.failEnvironmentPreflight).toHaveBeenCalledWith(workspaceId);
	expect(build.claimEnvironmentBuild).not.toHaveBeenCalled();
});
