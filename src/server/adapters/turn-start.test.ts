import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyDeliveryRequest } from "#/domain/delivery-auth";
import { withBackgroundJobDispatcher } from "./background-job-dispatch";
import { withExecutorBinding } from "./executor-fetch";
import { admitQueuedTurnsWith, startQueuedTurnsDirectly } from "./turn-start";

const mocks = vi.hoisted(() => ({ claim: vi.fn() }));
vi.mock("./api-turns", () => ({ claimApiTurn: mocks.claim }));

const secret = "k".repeat(64);
const session = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const lease = "00000000-0000-4000-8000-000000000003";
const claimed = {
	id: turnId,
	session_id: session,
	user_id: "owner",
	lease_id: lease,
};

beforeEach(() => {
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_URL", "https://edge.example/");
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_SECRET", secret);
	mocks.claim.mockReset();
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it("claims until nothing is left and hands each claimed turn to its chat", async () => {
	mocks.claim
		.mockResolvedValueOnce(claimed)
		.mockResolvedValueOnce({ ...claimed, session_id: "other" })
		.mockResolvedValueOnce(null);
	const start = vi
		.fn()
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await admitQueuedTurnsWith(start);
	expect(mocks.claim).toHaveBeenCalledTimes(3);
	expect(mocks.claim).toHaveBeenCalledWith(
		expect.any(Number),
		expect.any(Number),
		"durable-object",
	);
	expect(start).toHaveBeenNthCalledWith(1, {
		userId: "owner",
		sessionId: session,
		turnId,
		leaseId: lease,
	});
	expect(warn).toHaveBeenCalledWith(
		"Chat could not queue this turn; lease expiry will fail it.",
	);
});

it("is not taken outside the web Worker: no binding, or inside an edge invocation", async () => {
	expect(await startQueuedTurnsDirectly()).toBe(false);
	const executor = vi.fn();
	expect(
		await withExecutorBinding(executor, () =>
			withBackgroundJobDispatcher(async () => {}, startQueuedTurnsDirectly),
		),
	).toBe(false);
	vi.stubEnv("YTIMESY_BACKGROUND_WORKFLOW_URL", "");
	expect(await withExecutorBinding(executor, startQueuedTurnsDirectly)).toBe(
		false,
	);
	expect(executor).not.toHaveBeenCalled();
	expect(mocks.claim).not.toHaveBeenCalled();
});

it("starts the claimed turn through the executor binding with a signed request, resending once", async () => {
	mocks.claim.mockResolvedValueOnce(claimed).mockResolvedValueOnce(null);
	const seen: { url: string; body: string; valid: boolean }[] = [];
	const executor = vi.fn(async (url: string, init?: RequestInit) => {
		const body = String(init?.body);
		seen.push({
			url,
			body,
			valid: await verifyDeliveryRequest(secret, new Request(url, init), body),
		});
		if (seen.length === 1) throw new TypeError("binding reset");
		return new Response(null, { status: 204 });
	});
	expect(await withExecutorBinding(executor, startQueuedTurnsDirectly)).toBe(
		true,
	);
	expect(seen).toHaveLength(2);
	expect(seen[1]).toEqual({
		url: "https://edge.example/turn/start",
		body: JSON.stringify({
			userId: "owner",
			sessionId: session,
			turnId,
			leaseId: lease,
		}),
		valid: true,
	});
});

it("fails after a second failed start so the caller dispatches the admission job", async () => {
	mocks.claim.mockResolvedValueOnce(claimed);
	const executor = vi.fn(async () => new Response(null, { status: 503 }));
	await expect(
		withExecutorBinding(executor, startQueuedTurnsDirectly),
	).rejects.toThrow("Turn start failed.");
	expect(executor).toHaveBeenCalledTimes(2);
});
