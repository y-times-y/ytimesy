import { afterEach, expect, it, vi } from "vitest";
import { apiTurnFailureClassification } from "#/domain/api-turn-failure";
import { coordinateConversationTurn } from "./conversation-turn-control";

vi.mock("./realtime-delivery", () => ({
	realtimeDeliveryConfiguration: () => ({
		url: "https://realtime.example.test",
		secret: "test-secret-for-coordination-signatures-only",
	}),
}));
const turn = {
	userId: "owner",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
	leaseId: "33333333-3333-4333-8333-333333333333",
};
afterEach(() => vi.unstubAllGlobals());

it.each([401, 403, 429, 503])(
	"distinguishes HTTP %i without exposing a body",
	async (status) => {
		const fetcher = vi.fn(
			async () => new Response("private-token", { status }),
		);
		vi.stubGlobal("fetch", fetcher);
		const error = await coordinateConversationTurn("renew", turn).catch(
			(error) => error,
		);
		expect(apiTurnFailureClassification(error)).toMatchObject({
			action: "renew",
			attempts: status >= 429 ? 2 : 1,
			failure: { kind: "http", status },
		});
		expect(JSON.stringify(error)).not.toContain("private-token");
	},
);

it.each([
	[new TypeError("private endpoint"), "network"],
	[new DOMException("private timeout URL", "TimeoutError"), "timeout"],
] as const)(
	"distinguishes transport categories without raw causes",
	async (failure, category) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
		const error = await coordinateConversationTurn("renew", turn).catch(
			(error) => error,
		);
		expect(apiTurnFailureClassification(error)).toMatchObject({
			attempts: 2,
			failure: { kind: "transport", category },
		});
		expect(JSON.stringify(error)).not.toContain("private");
		expect(error.cause).toBeUndefined();
	},
);

it("retains safe HTTP diagnostics after exhausted retries", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("private response", { status: 503 })),
	);
	const error = await coordinateConversationTurn("renew", turn).catch(
		(error) => error,
	);
	expect(apiTurnFailureClassification(error)).toMatchObject({
		name: "CoordinationFailure",
		action: "renew",
		attempts: 2,
		failure: { kind: "http", status: 503 },
	});
	expect(JSON.stringify(error)).not.toContain("private response");
});

it("survives one transient renewal timeout without changing the lease identity", async () => {
	const fetcher = vi
		.fn()
		.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
		.mockResolvedValueOnce(new Response(null, { status: 204 }));
	vi.stubGlobal("fetch", fetcher);
	await expect(coordinateConversationTurn("renew", turn)).resolves.toBe(true);
	expect(fetcher).toHaveBeenCalledTimes(2);
	for (const [, request] of fetcher.mock.calls)
		expect(JSON.parse(request.body)).toEqual(turn);
});

it("never retries a rejected or cancelled lease", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValue(new Response(null, { status: 409 }));
	vi.stubGlobal("fetch", fetcher);
	expect(await coordinateConversationTurn("renew", turn)).toBe(false);
	expect(fetcher).toHaveBeenCalledOnce();
});

it("bounds unavailable-service renewals to two attempts", async () => {
	const fetcher = vi
		.fn()
		.mockImplementation(async () => new Response(null, { status: 503 }));
	vi.stubGlobal("fetch", fetcher);
	await expect(coordinateConversationTurn("renew", turn)).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not retry authentication failures or ambiguous releases", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 403 }));
	vi.stubGlobal("fetch", fetcher);
	await expect(coordinateConversationTurn("renew", turn)).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledOnce();
	fetcher
		.mockReset()
		.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
	await expect(coordinateConversationTurn("release", turn)).rejects.toThrow();
	expect(fetcher).toHaveBeenCalledOnce();
});
