import { describe, expect, it, vi } from "vitest";
import { probeSubscription } from "../scripts/subscription-egress-probe";
import worker from "../scripts/subscription-egress-worker";
import { signDeliveryRequest } from "../src/domain/delivery-auth";

describe("subscription egress probe", () => {
	it("invokes a remote binding without relying on Function.bind", async () => {
		const secret = "test-probe-signing-secret-at-least-32";
		const url = "https://proof.test/catalog";
		const request = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ models: [] }));
		const remote = new Proxy(request, {
			get(target, property, receiver) {
				if (property === "bind")
					throw new Error("Remote binding is not a native Function");
				return Reflect.get(target, property, receiver);
			},
		});
		const response = await worker.fetch(
			new Request(url, {
				method: "POST",
				headers: await signDeliveryRequest(secret, "POST", url),
			}),
			{
				EGRESS: { fetch: remote },
				REQUIRE_VPC: "1",
				PROBE_SECRET: secret,
				PROBE_ACCESS_TOKEN: "private-token",
				PROBE_ACCOUNT_ID: "private-account",
				PROBE_MODEL: "test-model",
				PROBE_EXPIRES: String(Date.now() + 60_000),
			},
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: 200,
			category: "json",
		});
		expect(request).toHaveBeenCalledOnce();
	});
	it("uses the supplied transport for the fixed subscription endpoint", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response('data: {"type":"response.completed"}\n\n', {
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const result = await probeSubscription(
			{
				accessToken: "private-token",
				accountId: "private-account",
				model: "test-model",
			},
			true,
			request,
		);
		expect(result).toMatchObject({
			status: 200,
			category: "sse",
			completed: true,
		});
		expect(request).toHaveBeenCalledOnce();
		expect(request.mock.calls[0][0]).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		);
		expect(request.mock.calls[0][1]).toMatchObject({
			method: "POST",
			redirect: "manual",
		});
		expect(JSON.stringify(result)).not.toContain("private-");
	});

	it("does not fall back to ordinary fetch when VPC is required", async () => {
		const response = await worker.fetch(
			new Request("https://proof.test/catalog", { method: "POST" }),
			{
				REQUIRE_VPC: "1",
				PROBE_SECRET: "test-secret",
				PROBE_ACCESS_TOKEN: "private-token",
				PROBE_ACCOUNT_ID: "private-account",
				PROBE_MODEL: "test-model",
				PROBE_EXPIRES: String(Date.now() + 60_000),
			},
		);
		expect(response.status).toBe(503);
	});
});
