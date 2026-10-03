import { expect, it } from "vitest";
import { signDeliveryRequest, verifyDeliveryRequest } from "./delivery-auth";

const secret = "a".repeat(32);
it("authenticates body, method, scope and expiry rather than exposing a browser secret", async () => {
	const url = "https://delivery.example/stream?userId=alice&sessionId=one";
	const headers = await signDeliveryRequest(secret, "GET", url);
	expect(
		await verifyDeliveryRequest(secret, new Request(url, { headers }), ""),
	).toBe(true);
	expect(
		await verifyDeliveryRequest(
			secret,
			new Request(url.replace("alice", "bob"), { headers }),
			"",
		),
	).toBe(false);
	expect(
		await verifyDeliveryRequest(
			secret,
			new Request(url, { method: "POST", headers }),
			"",
		),
	).toBe(false);
	expect(
		await verifyDeliveryRequest(
			secret,
			new Request(url, { headers }),
			"changed",
		),
	).toBe(false);
	expect(
		await verifyDeliveryRequest(
			"b".repeat(32),
			new Request(url, { headers }),
			"",
		),
	).toBe(false);
	expect(
		await verifyDeliveryRequest(
			secret,
			new Request(url, {
				headers: { ...headers, "x-ytimesy-delivery-expires": "1000000000000" },
			}),
			"",
		),
	).toBe(false);
});
