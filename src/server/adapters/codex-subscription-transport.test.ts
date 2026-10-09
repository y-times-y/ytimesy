import { beforeEach, expect, it, vi } from "vitest";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import {
	handleCodexSubscriptionRelay,
	subscriptionConnection,
	subscriptionFetch,
	withCodexSubscriptionEgress,
} from "./codex-subscription-transport";

const auth = vi.hoisted(() => vi.fn());
vi.mock("../auth/codex-managed-auth", () => ({ codexExternalTokens: auth }));
const secret = "test-subscription-relay-signing-secret";
const url = "https://backend.example/api/internal/codex-transport";

it("scopes VPC transport to its invocation, preserving streams, account fencing and cancellation", async () => {
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL", url);
	const ordinary = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(Response.json({ accountId: "owner-account" }));
	const stream = new ReadableStream<Uint8Array>();
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
	const controller = new AbortController();
	await withCodexSubscriptionEgress(vpc, async () => {
		expect(await subscriptionConnection("owner")).toMatchObject({
			accessToken: "owner-token",
		});
		const response = await subscriptionFetch(
			"owner",
			"codex/responses",
			{
				method: "POST",
				body: "{}",
				signal: controller.signal,
			},
			"owner-account",
		);
		expect(response.body).toBe(stream);
		expect(vpc).toHaveBeenCalledOnce();
		expect(ordinary).not.toHaveBeenCalled();
		expect(vpc.mock.calls[0][1]?.signal).toBe(controller.signal);
		await expect(
			subscriptionFetch("owner", "codex/responses", {}, "other-account"),
		).rejects.toThrow("account changed");
	});
	await subscriptionConnection("owner");
	expect(ordinary).toHaveBeenCalledOnce();
	expect(vpc).toHaveBeenCalledOnce();
});
beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	auth.mockReset().mockResolvedValue({
		accessToken: "owner-token",
		chatgptAccountId: "owner-account",
	});
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET", secret);
});
async function signed(input: unknown) {
	const body = JSON.stringify(input);
	return new Request(url, {
		method: "POST",
		body,
		headers: await signDeliveryRequest(secret, "POST", url, body),
	});
}

it("rejects unsigned, altered, arbitrary-endpoint and wrong-account requests before egress", async () => {
	const fetch = vi.spyOn(globalThis, "fetch");
	expect(
		(
			await handleCodexSubscriptionRelay(
				new Request(url, { method: "POST", body: "{}" }),
			)
		).status,
	).toBe(401);
	expect(auth).not.toHaveBeenCalled();
	expect(
		(
			await handleCodexSubscriptionRelay(
				await signed({
					userId: "owner",
					operation: { kind: "metadata", path: "https://attacker.example" },
				}),
			)
		).status,
	).toBe(400);
	expect(
		(
			await handleCodexSubscriptionRelay(
				await signed({
					userId: "owner",
					accountId: "other-account",
					operation: { kind: "inference", path: "codex/responses", body: "{}" },
				}),
			)
		).status,
	).toBe(409);
	expect(fetch).not.toHaveBeenCalled();
});
it("streams responses without buffering, using refreshed owner credentials and only allowed headers", async () => {
	const stream = new ReadableStream<Uint8Array>();
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"set-cookie": "private-cookie",
			},
		}),
	);
	const response = await handleCodexSubscriptionRelay(
		await signed({
			userId: "owner",
			accountId: "owner-account",
			operation: {
				kind: "inference",
				path: "codex/responses",
				body: '{"stream":true}',
				sessionId: "a".repeat(64),
			},
		}),
	);
	expect(response.body).toBe(stream);
	expect(response.headers.get("set-cookie")).toBeNull();
	expect(auth).toHaveBeenCalledWith("owner");
	const [target, init] = fetch.mock.calls[0];
	expect(target).toBe("https://chatgpt.com/backend-api/codex/responses");
	expect(new Headers(init?.headers).get("authorization")).toBe(
		"Bearer owner-token",
	);
	expect(new Headers(init?.headers).get("session-id")).toBe("a".repeat(64));
	expect(init?.redirect).toBe("manual");
	await response.body?.cancel();
});
it("redacts upstream failures, never follows redirects and never retries uncertain inference", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("private-provider-html", { status: 403 }));
	const response = await handleCodexSubscriptionRelay(
		await signed({
			userId: "owner",
			operation: { kind: "metadata", path: "wham/usage" },
		}),
	);
	expect(response.status).toBe(403);
	expect(await response.text()).not.toContain("private-provider-html");
	expect(fetch).toHaveBeenCalledTimes(1);
});
it("does not refresh tokens in the DO or send them to the configured relay", async () => {
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL", url);
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(Response.json({ accountId: "owner-account" }));
	expect(await subscriptionConnection("owner")).toEqual({
		chatgptAccountId: "owner-account",
		accessToken: "subscription-relay",
	});
	expect(auth).not.toHaveBeenCalled();
	const body = fetch.mock.calls[0][1]?.body as string;
	expect(body).not.toContain("owner-token");
	expect(body).toContain('"userId":"owner"');
	const signal = new AbortController().signal;
	await subscriptionFetch(
		"owner",
		"codex/responses",
		{ method: "POST", body: "{}", signal },
		"owner-account",
	);
	expect(fetch.mock.calls[1][1]?.signal).toBe(signal);
	expect(JSON.parse(fetch.mock.calls[1][1]?.body as string).accountId).toBe(
		"owner-account",
	);
});
it("rejects invalid relay configuration instead of falling back to direct egress", async () => {
	vi.stubEnv(
		"YTIMESY_CODEX_RELAY_URL",
		"http://backend.example/api/internal/codex-transport",
	);
	const fetch = vi.spyOn(globalThis, "fetch");
	await expect(subscriptionFetch("owner", "wham/usage")).rejects.toThrow(
		"Invalid subscription relay URL",
	);
	expect(fetch).not.toHaveBeenCalled();
});

it("does not forward signed requests across relay redirects", async () => {
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL", url);
	const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(null, {
			status: 302,
			headers: { location: "https://attacker.example" },
		}),
	);
	await expect(subscriptionFetch("owner", "wham/usage")).rejects.toThrow(
		"redirects are not allowed",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
});

it("passes cancellation to upstream inference without adding a turn deadline", async () => {
	const abort = new AbortController();
	const input = {
		userId: "owner",
		operation: { kind: "inference", path: "codex/responses", body: "{}" },
	};
	const signedRequest = await signed(input);
	const request = new Request(signedRequest, { signal: abort.signal });
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(null));
	await handleCodexSubscriptionRelay(request);
	abort.abort();
	expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
