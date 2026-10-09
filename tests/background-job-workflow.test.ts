import { afterEach, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({ deliver: vi.fn(), claim: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		constructor(
			_ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../src/server/adapters/database-scope", () => ({
	withDatabaseScope: async (_url: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("../src/server/adapters/api-turns", () => ({
	claimApiTurn: handlers.claim,
}));
vi.mock("../src/server/services/background-job-delivery", () => ({
	deliverBackgroundJob: handlers.deliver,
}));

import { BackgroundJobWorkflow } from "../src/server/edge/background-job-workflow";

const id = "00000000-0000-4000-8000-000000000001";
function fixture() {
	const createBatch = vi.fn(async () => []);
	const step = {
		do: vi.fn(async (_name, _options, run) => run()),
		sleep: vi.fn(async () => {}),
	};
	const workflow = new BackgroundJobWorkflow(
		{} as never,
		{
			HYPERDRIVE: { connectionString: "fixture" },
			BACKGROUND_JOBS: { createBatch },
			MODEL_TURNS: { createBatch },
			PROJECT_ENVIRONMENTS: { createBatch },
			ENVIRONMENT_EXECUTION_ENABLED: "1",
		} as never,
	);
	return { workflow, step, createBatch };
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("waits durably only for an explicitly pending peer message", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	handlers.deliver
		.mockResolvedValueOnce("pending")
		.mockResolvedValueOnce("delivered");
	const { workflow, step } = fixture();
	expect(
		await workflow.run(
			{
				payload: {
					id,
					kind: "peer-message",
					userId: "u",
					senderId: "s",
					recipientId: "r",
					message: "coordinate",
				},
			} as never,
			step as never,
		),
	).toEqual({ outcome: "delivered" });
	expect(step.sleep).toHaveBeenCalledWith("await-peer-0", "15 seconds");
	expect(handlers.deliver).toHaveBeenCalledTimes(2);
	expect(step.do.mock.calls.every((call) => call[1].retries.limit === 0)).toBe(
		true,
	);
});

it("does not replay uncertain side effects", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	handlers.deliver.mockRejectedValue(new Error("uncertain edit"));
	const { workflow, step } = fixture();
	await expect(
		workflow.run(
			{ payload: { id, kind: "competition", rootSessionId: "s" } } as never,
			step as never,
		),
	).rejects.toThrow("uncertain edit");
	expect(handlers.deliver).toHaveBeenCalledTimes(1);
	expect(step.sleep).not.toHaveBeenCalled();
});

it("preserves the refresh recipe and job identity when admitting environment work", async () => {
	const { workflow, step, createBatch } = fixture();
	await workflow.run(
		{
			payload: {
				id,
				kind: "prepare",
				workspaceId: "w",
				force: false,
				repairModel: null,
			},
		} as never,
		step as never,
	);
	expect(createBatch).toHaveBeenCalledWith([
		{
			id,
			params: {
				requestId: id,
				workspaceId: "w",
				force: false,
				repairModel: null,
			},
		},
	]);
});

it("claims only Cloudflare turns and dispatches their persisted lease identities", async () => {
	vi.stubEnv("MODEL_EXECUTION_ENABLED", "1");
	handlers.claim
		.mockResolvedValueOnce({
			id,
			lease_id: "00000000-0000-4000-8000-000000000002",
		})
		.mockResolvedValueOnce(null);
	const { workflow, step, createBatch } = fixture();
	await workflow.run(
		{ payload: { id, kind: "model-admission" } } as never,
		step as never,
	);
	expect(handlers.claim.mock.calls[0][2]).toBe("durable-object");
	expect(createBatch).toHaveBeenCalledWith([
		{
			id: `${id}-00000000-0000-4000-8000-000000000002`,
			params: { turnId: id, leaseId: "00000000-0000-4000-8000-000000000002" },
		},
	]);
});
