import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { executeWorkflowRequest } from "./model-workflow-executor";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	finalize: vi.fn(),
	complete: vi.fn(),
	run: vi.fn(),
	stage: vi.fn(),
}));
vi.mock("../services/pr-repair-webhook", () => ({
	stageVerifiedPrRepairSignal: mocks.stage,
}));
vi.mock("../adapters/model-workflow-steps", () => ({
	claimModelWorkflowStep: mocks.claim,
	completeModelWorkflowStep: mocks.complete,
}));
vi.mock("./api-turn", () => ({ runApiTurn: mocks.run }));
vi.mock("../adapters/api-turns", () => ({ finalizeApiTurn: mocks.finalize }));
vi.mock("../adapters/conversation-turn-control", () => ({
	coordinateConversationTurn: vi.fn(async () => true),
}));
const secret = "test-only-workflow-signing-secret-12345678";
const url = "https://executor.example/model-step";
const step = {
	turnId: "00000000-0000-4000-8000-000000000001",
	leaseId: "00000000-0000-4000-8000-000000000002",
	index: 1,
};
const machines = {} as WorkspaceMachines;
async function request(body = JSON.stringify(step), signed = true) {
	return new Request(url, {
		method: "POST",
		body,
		headers: signed ? await signDeliveryRequest(secret, "POST", url, body) : {},
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.claim.mockResolvedValue({
		kind: "claimed",
		turn: { id: step.turnId },
		remainingMs: 1000,
	});
	mocks.run.mockResolvedValue("continue");
});
afterEach(() => vi.unstubAllEnvs());

it("persists only authenticated, explicitly enabled repair references without running inference", async () => {
	const endpoint = "https://executor.example/pr-repair-event";
	const delivery = {
		deliveryId: step.turnId,
		signal: {
			repositoryId: 1,
			fullName: "owner/repo",
			installationId: 1,
			headSha: "a".repeat(40),
			kind: "check_run",
			sourceId: 3,
			prNumber: null,
		},
	};
	const body = JSON.stringify(delivery);
	const headers = await signDeliveryRequest(secret, "POST", endpoint, body);
	const unsigned = new Request(endpoint, { method: "POST", body });
	expect(
		(await executeWorkflowRequest(unsigned, secret, machines)).status,
	).toBe(401);
	vi.stubEnv("YTIMESY_PR_REPAIR_ENABLED", "1");
	expect(
		(
			await executeWorkflowRequest(
				new Request(endpoint, { method: "POST", body, headers }),
				secret,
				machines,
			)
		).status,
	).toBe(200);
	expect(mocks.stage).toHaveBeenCalledWith(
		delivery.deliveryId,
		delivery.signal,
	);
	expect(mocks.run).not.toHaveBeenCalled();
	expect(mocks.claim).not.toHaveBeenCalled();
});

it("rejects unauthenticated, oversized, malformed and credential-bearing requests before execution", async () => {
	for (const [input, status] of [
		[await request(undefined, false), 401],
		[await request("x".repeat(1025)), 413],
		[await request("{"), 400],
		[await request(JSON.stringify({ ...step, apiKey: "forbidden" })), 400],
	] as const)
		expect((await executeWorkflowRequest(input, secret, machines)).status).toBe(
			status,
		);
	expect(mocks.claim).not.toHaveBeenCalled();
	expect(mocks.run).not.toHaveBeenCalled();
});

it("reuses only known outcomes and refuses uncertain processing without replay", async () => {
	mocks.claim.mockResolvedValueOnce({ kind: "done", outcome: "completed" });
	expect(
		await (
			await executeWorkflowRequest(await request(), secret, machines)
		).json(),
	).toEqual({ outcome: "completed" });
	mocks.claim.mockResolvedValueOnce({ kind: "unavailable" });
	expect(
		(await executeWorkflowRequest(await request(), secret, machines)).status,
	).toBe(409);
	expect(mocks.run).not.toHaveBeenCalled();
});

it("settles a between-step cancellation without inference or waiting for lease expiry", async () => {
	mocks.claim.mockResolvedValue({
		kind: "cancelled",
		turn: { id: step.turnId, items: [] },
	});
	mocks.finalize.mockResolvedValue("cancelled");
	expect(
		await (
			await executeWorkflowRequest(await request(), secret, machines)
		).json(),
	).toEqual({ outcome: "cancelled" });
	expect(mocks.run).not.toHaveBeenCalled();
	mocks.finalize.mockResolvedValue(null);
	expect(
		(await executeWorkflowRequest(await request(), secret, machines)).status,
	).toBe(409);
});

it("records outcomes only after execution and does not leak messages into the response", async () => {
	mocks.run.mockImplementation(async () => {
		expect(mocks.complete).not.toHaveBeenCalled();
		return "continue";
	});
	const response = await executeWorkflowRequest(
		await request(),
		secret,
		machines,
	);
	expect(await response.json()).toEqual({ outcome: "continue" });
	expect(mocks.complete).toHaveBeenCalledWith(step, "continue");
});

it("fences expired turns immediately and makes step 31 a no-inference failure", async () => {
	mocks.claim.mockResolvedValue({ kind: "claimed", turn: {}, remainingMs: 0 });
	mocks.run.mockImplementation(async (_machines, _turn, options) => {
		expect(options.signal.aborted).toBe(true);
		expect(options.limitReached).toBe(true);
		return "cancelled";
	});
	await executeWorkflowRequest(
		await request(JSON.stringify({ ...step, index: 31 })),
		secret,
		machines,
	);
});
