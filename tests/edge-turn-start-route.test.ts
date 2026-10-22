import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

const mocks = vi.hoisted(() => ({
	startClaimed: vi.fn(),
	roomFetch: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../src/server/edge/background-jobs", () => ({
	BackgroundJobRunner: class {},
	admitQueuedTurns: vi.fn(),
	runBackgroundJob: vi.fn(),
	startBackgroundJob: vi.fn(),
	startClaimedTurn: mocks.startClaimed,
}));

import executor from "../src/server/edge/executor";

const secret = "w".repeat(40);
const realtime = "r".repeat(40);
const env = {
	BACKGROUND_EXECUTION_ENABLED: "1",
	BACKGROUND_WORKFLOW_SECRET: secret,
	MODEL_CONVERSATIONS: {
		getByName: () => ({ fetch: mocks.roomFetch }),
	},
} as never;
const turn = {
	userId: "owner",
	sessionId: "00000000-0000-4000-8000-000000000001",
	turnId: "00000000-0000-4000-8000-000000000002",
	leaseId: "00000000-0000-4000-8000-000000000003",
};
async function signed(path: string, body: string, key = secret) {
	const url = `https://edge.example${path}`;
	return new Request(url, {
		method: "POST",
		body,
		headers: {
			...(await signDeliveryRequest(key, "POST", url, body)),
			"content-type": "application/json",
		},
	});
}

beforeEach(() => {
	vi.stubEnv("MODEL_EXECUTION_ENABLED", "1");
	vi.stubEnv("YTIMESY_REALTIME_SECRET", realtime);
	mocks.startClaimed.mockReset().mockResolvedValue(true);
	mocks.roomFetch
		.mockReset()
		.mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => vi.unstubAllEnvs());

it("hands a signed POST /turn/start to the chat's startTurn, not to the room", async () => {
	const response = await executor.fetch(
		await signed("/turn/start", JSON.stringify(turn)),
		env,
	);
	expect(response.status).toBe(204);
	expect(mocks.startClaimed).toHaveBeenCalledWith(env, turn);
	expect(mocks.roomFetch).not.toHaveBeenCalled();
	mocks.startClaimed.mockResolvedValueOnce(false);
	expect(
		(
			await executor.fetch(
				await signed("/turn/start", JSON.stringify(turn)),
				env,
			)
		).status,
	).toBe(409);
	// Unsigned or wrongly signed: refused before any chat is touched.
	expect(
		(
			await executor.fetch(
				await signed("/turn/start", JSON.stringify(turn), "x".repeat(40)),
				env,
			)
		).status,
	).toBe(401);
	expect(mocks.startClaimed).toHaveBeenCalledTimes(2);
});

it("still routes the room's turn coordination to the room", async () => {
	const control = JSON.stringify({
		userId: turn.userId,
		sessionId: turn.sessionId,
		turnId: turn.turnId,
		leaseId: turn.leaseId,
	});
	for (const action of ["acquire", "renew", "release", "cancel"]) {
		mocks.roomFetch.mockClear();
		const response = await executor.fetch(
			await signed(`/turn/${action}`, control, realtime),
			env,
		);
		expect(response.status, action).toBe(204);
		expect(mocks.roomFetch, action).toHaveBeenCalledOnce();
	}
	expect(mocks.startClaimed).not.toHaveBeenCalled();
});
