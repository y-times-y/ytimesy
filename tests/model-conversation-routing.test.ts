import { expect, it, vi } from "vitest";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import {
	modelConversationName,
	routeModelConversationStep,
} from "../src/domain/model-conversation-routing";

const secret = "model-routing-test-key".repeat(3);
const url = "https://executor.example/model-step";
const step = {
	turnId: "00000000-0000-4000-8000-000000000001",
	leaseId: "00000000-0000-4000-8000-000000000002",
	index: 1,
};
async function signedRequest(body = JSON.stringify(step)) {
	return new Request(url, {
		method: "POST",
		body,
		headers: await signDeliveryRequest(secret, "POST", url, body),
	});
}

it("authenticates and bounds references before accessing owner records or objects", async () => {
	const resolve = vi.fn();
	const forward = vi.fn();
	for (const [request, status] of [
		[new Request(url, { method: "POST", body: "{}" }), 401],
		[await signedRequest("x".repeat(1025)), 413],
		[await signedRequest("{"), 400],
		[await signedRequest(JSON.stringify({ ...step, userId: "attacker" })), 400],
		[await signedRequest(JSON.stringify({ ...step, index: 0 })), 400],
		[new Request(url), 404],
	] as const) {
		expect(
			(await routeModelConversationStep(request, secret, resolve, forward))
				.status,
		).toBe(status);
	}
	expect(resolve).not.toHaveBeenCalled();
	expect(forward).not.toHaveBeenCalled();
});

it("routes database-owned scope and preserves the signature and cancellation signal", async () => {
	const request = await signedRequest();
	const scope = { userId: "alice", sessionId: "chat-a" };
	const resolve = vi.fn(async () => scope);
	const forward = vi.fn(async (owner, forwarded: Request) => {
		expect(owner).toEqual(scope);
		expect(await forwarded.text()).toBe(JSON.stringify(step));
		expect([...forwarded.headers]).toEqual([...request.headers]);
		expect(forwarded.url).toBe(request.url);
		expect(forwarded.signal.aborted).toBe(false);
		return Response.json({ outcome: "continue" });
	});
	const response = await routeModelConversationStep(
		request,
		secret,
		resolve,
		forward,
	);
	expect(resolve).toHaveBeenCalledExactlyOnceWith(step);
	expect(await response.json()).toEqual({ outcome: "continue" });
});

it("does not create or invoke a conversation for unknown or stale leases", async () => {
	const forward = vi.fn();
	expect(
		(
			await routeModelConversationStep(
				await signedRequest(),
				secret,
				async () => null,
				forward,
			)
		).status,
	).toBe(409);
	expect(forward).not.toHaveBeenCalled();
});

it("keeps chat and owner identity distinct without delimiter collisions", () => {
	expect(modelConversationName({ userId: "a:b", sessionId: "c" })).not.toBe(
		modelConversationName({ userId: "a", sessionId: "b:c" }),
	);
	expect(
		modelConversationName({ userId: "alice", sessionId: "chat" }),
	).not.toBe(modelConversationName({ userId: "bob", sessionId: "chat" }));
});
