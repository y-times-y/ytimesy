import { afterEach, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({ deliver: vi.fn(), claim: vi.fn() }));
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
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

import {
	BackgroundJobRunner,
	runBackgroundJob,
} from "../src/server/edge/background-jobs";

const id = "00000000-0000-4000-8000-000000000001";
function environment() {
	const createBatch = vi.fn(async (_batch: unknown[]) => []);
	return {
		createBatch,
		env: {
			HYPERDRIVE: { connectionString: "fixture" },
			MODEL_CONVERSATIONS: {
				getByName: (name: string) => ({
					startTurn: async (scope: unknown, turn: unknown) => {
						await createBatch([{ name, scope, turn }]);
						return true;
					},
				}),
			},
			PROJECT_ENVIRONMENTS: {
				getByName: (name: string) => ({
					start: async (request: unknown) => {
						await createBatch([{ name, request }]);
					},
				}),
			},
			ENVIRONMENT_EXECUTION_ENABLED: "1",
		} as never,
	};
}
function runner() {
	const store = new Map<string, unknown>();
	const alarms: number[] = [];
	const storage = {
		get: vi.fn(async (key: string) => store.get(key)),
		put: vi.fn(
			async (key: string, value: unknown) => void store.set(key, value),
		),
		deleteAll: vi.fn(async () => store.clear()),
		setAlarm: vi.fn(async (at: number) => void alarms.push(at)),
	};
	const object = new BackgroundJobRunner(
		{ storage } as never,
		environment().env,
	);
	return { object, store, alarms };
}
const peer = {
	id,
	kind: "peer-message",
	userId: "u",
	senderId: "s",
	recipientId: "r",
	message: "coordinate",
} as const;
afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetAllMocks();
});

it("retries only an explicitly pending peer message", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	handlers.deliver
		.mockResolvedValueOnce("pending")
		.mockResolvedValueOnce("delivered");
	const { object, store, alarms } = runner();
	await object.start(peer);
	await object.alarm();
	expect(store.get("job")).toMatchObject({ state: "queued", attempts: 1 });
	expect(alarms[1] - alarms[0]).toBeGreaterThanOrEqual(15_000);
	await object.alarm();
	expect(store.get("job")).toMatchObject({ state: "done" });
	expect(handlers.deliver).toHaveBeenCalledTimes(2);
});

it("runs a repeated admission of the same job only once", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	handlers.deliver.mockResolvedValue("delivered");
	const { object } = runner();
	await object.start(peer);
	await object.alarm();
	await object.start(peer);
	await object.alarm();
	expect(handlers.deliver).toHaveBeenCalledTimes(1);
});

it("does not replay uncertain side effects", async () => {
	vi.stubEnv("FREESTYLE_API_KEY", "fixture");
	handlers.deliver.mockRejectedValue(new Error("uncertain edit"));
	const { object, store } = runner();
	await object.start({ id, kind: "competition", rootSessionId: "s" });
	await object.alarm();
	expect(store.get("job")).toMatchObject({ state: "failed" });
	expect(handlers.deliver).toHaveBeenCalledTimes(1);
});

it("fails closed when an interrupted run is re-fired", async () => {
	const { object, store } = runner();
	store.set("job", { job: peer, state: "running", attempts: 0 });
	await object.alarm();
	expect(store.get("job")).toMatchObject({ state: "failed" });
	expect(handlers.deliver).not.toHaveBeenCalled();
});

it("preserves the refresh recipe and job identity when admitting environment work", async () => {
	const { env, createBatch } = environment();
	await runBackgroundJob(env, {
		id,
		kind: "prepare",
		workspaceId: "w",
		force: false,
		repairModel: null,
	});
	expect(createBatch).toHaveBeenCalledWith([
		{
			name: "w",
			request: {
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
			user_id: "u",
			session_id: "s",
		})
		.mockResolvedValueOnce(null);
	const { env, createBatch } = environment();
	await runBackgroundJob(env, { id, kind: "model-admission" });
	expect(handlers.claim.mock.calls[0][2]).toBe("durable-object");
	expect(createBatch).toHaveBeenCalledWith([
		expect.objectContaining({
			scope: { userId: "u", sessionId: "s" },
			turn: { turnId: id, leaseId: "00000000-0000-4000-8000-000000000002" },
		}),
	]);
});
