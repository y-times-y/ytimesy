import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signDeliveryRequest } from "#/domain/delivery-auth";
import {
	handleCodexSubscriptionRelay,
	probeCodexEgress,
	resetCodexEgressHealthForTests,
	subscriptionFetch,
	withCodexSubscriptionEgress,
} from "./codex-subscription-transport";

const auth = vi.hoisted(() => vi.fn());
vi.mock("../auth/codex-managed-auth", () => ({ codexExternalTokens: auth }));
const relayOne = "https://relay-one.example/api/internal/codex-transport";
const relayTwo = "https://relay-two.example/api/internal/codex-transport";
const blockedHtml = () =>
	new Response("<html>Forbidden</html>", {
		status: 403,
		headers: { "content-type": "text/html" },
	});

beforeEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	resetCodexEgressHealthForTests();
	auth.mockReset().mockResolvedValue({
		accessToken: "owner-token",
		chatgptAccountId: "owner-account",
	});
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL", relayOne);
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET", "r".repeat(32));
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL_2", relayTwo);
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET_2", "s".repeat(32));
});
afterEach(() => {
	vi.useRealTimers();
});

const relayHost = (call: unknown[]) => new URL(String(call[0])).host;
const inference = (signal?: AbortSignal) =>
	subscriptionFetch(
		"owner",
		"codex/responses",
		{ method: "POST", body: '{"input":"same request"}', signal },
		"owner-account",
	);

it("resends the same inference on the next path when the VPC egress is blocked", async () => {
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(blockedHtml());
	const relays = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("data: ok\n\n"));
	const response = await withCodexSubscriptionEgress(vpc, () => inference());
	expect(await response.text()).toBe("data: ok\n\n");
	expect(vpc).toHaveBeenCalledOnce();
	expect(relays).toHaveBeenCalledOnce();
	expect(relayHost(relays.mock.calls[0])).toBe("relay-one.example");
	const sent = JSON.parse(relays.mock.calls[0][1]?.body as string);
	expect(sent.operation).toEqual({
		kind: "inference",
		path: "codex/responses",
		body: '{"input":"same request"}',
	});
	expect(sent.accountId).toBe("owner-account");
	// No OAuth token leaves for the relay.
	expect(relays.mock.calls[0][1]?.body).not.toContain("owner-token");
});

it("tries relays in order and skips a blocked path until its cooldown ends", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(blockedHtml());
	const relays = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input) =>
			new URL(String(input)).host === "relay-one.example"
				? new Response(null, { status: 401 })
				: new Response("data: two\n\n"),
		);
	await withCodexSubscriptionEgress(vpc, async () => {
		expect(await (await inference()).text()).toBe("data: two\n\n");
		expect(relays.mock.calls.map(relayHost)).toEqual([
			"relay-one.example",
			"relay-two.example",
		]);
		relays.mockClear();
		vpc.mockClear();
		// Both blocked paths cool down: the healthy relay goes first.
		await inference();
		expect(vpc).not.toHaveBeenCalled();
		expect(relays.mock.calls.map(relayHost)).toEqual(["relay-two.example"]);
		vi.advanceTimersByTime(5 * 60_000 + 1);
		vpc.mockResolvedValue(new Response("data: vpc\n\n"));
		expect(await (await inference()).text()).toBe("data: vpc\n\n");
		expect(vpc).toHaveBeenCalledOnce();
	});
});

it("never fails over on account or request errors", async () => {
	const relays = vi.spyOn(globalThis, "fetch");
	for (const upstream of [
		() =>
			Response.json(
				{ error: { code: "token_expired", message: "expired" } },
				{ status: 401 },
			),
		() =>
			Response.json(
				{ error: { type: "usage_limit_reached", resets_at: 1_800_000_000 } },
				{ status: 429 },
			),
		() =>
			Response.json(
				{ error: { type: "rate_limit_exceeded", message: "slow down" } },
				{ status: 429 },
			),
		() => Response.json({ error: { message: "bad input" } }, { status: 400 }),
	]) {
		const vpc = vi
			.fn<typeof fetch>()
			.mockImplementation(async () => upstream());
		const response = await withCodexSubscriptionEgress(vpc, () => inference());
		expect(response.status).toBe(upstream().status);
		// The caller still reads the provider's error (usage-limit reset, refresh).
		expect(await response.json()).toEqual(await upstream().json());
	}
	expect(relays).not.toHaveBeenCalled();
});

it("never retries once a response has started streaming", async () => {
	const relays = vi.spyOn(globalThis, "fetch");
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
			controller.error(new TypeError("connection reset"));
		},
	});
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
	const response = await withCodexSubscriptionEgress(vpc, () => inference());
	await expect(response.text()).rejects.toThrow("connection reset");
	expect(vpc).toHaveBeenCalledOnce();
	expect(relays).not.toHaveBeenCalled();
});

it("does not resend a body that cannot be replayed", async () => {
	const relays = vi.spyOn(globalThis, "fetch");
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(blockedHtml());
	const response = await withCodexSubscriptionEgress(vpc, () =>
		subscriptionFetch("owner", "codex/responses", {
			method: "POST",
			body: new ReadableStream<Uint8Array>(),
		}),
	);
	expect(response.status).toBe(403);
	expect(relays).not.toHaveBeenCalled();
});

it("fails over on transport errors and missing headers, but not on caller cancellation", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const relays = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => Response.json({ models: [] }));
	const hang: typeof fetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			if (init?.signal?.aborted) reject(init.signal.reason);
			init?.signal?.addEventListener("abort", () =>
				reject(init.signal?.reason),
			);
		});
	await withCodexSubscriptionEgress(vi.fn<typeof fetch>(hang), async () => {
		const pending = subscriptionFetch("owner", "wham/usage");
		await vi.advanceTimersByTimeAsync(6_001);
		expect((await pending).status).toBe(200);
		expect(relays).toHaveBeenCalledOnce();
	});
	resetCodexEgressHealthForTests();
	relays.mockClear();
	await withCodexSubscriptionEgress(
		vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
		async () => {
			expect((await subscriptionFetch("owner", "wham/usage")).status).toBe(200);
			expect(relays).toHaveBeenCalledOnce();
		},
	);
	resetCodexEgressHealthForTests();
	relays.mockClear();
	const controller = new AbortController();
	await withCodexSubscriptionEgress(vi.fn<typeof fetch>(hang), async () => {
		const pending = inference(controller.signal);
		controller.abort(new DOMException("stopped", "AbortError"));
		await expect(pending).rejects.toThrow("stopped");
		expect(relays).not.toHaveBeenCalled();
	});
});

it("names every blocked path when none can carry the request", async () => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
		new URL(String(input)).host === "relay-one.example"
			? Response.json(
					{ error: { type: "subscription_egress_blocked" } },
					{ status: 403 },
				)
			: Promise.reject(new TypeError("fetch failed")),
	);
	const vpc = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response("error code: 1020", { status: 403 }));
	await expect(
		withCodexSubscriptionEgress(vpc, () => inference()),
	).rejects.toThrow(
		"Codex subscription is unreachable: every network path was blocked (vpc: cloudflare-block, relay-1: forbidden-html, relay-2: transport). Nothing was sent to the model.",
	);
});

it("relays report a blocked upstream distinctly from a provider rejection", async () => {
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET", "r".repeat(32));
	const signed = async () => {
		const body = JSON.stringify({
			userId: "owner",
			operation: { kind: "metadata", path: "wham/usage" },
		});
		return new Request(relayOne, {
			method: "POST",
			body,
			headers: await signDeliveryRequest(
				"r".repeat(32),
				"POST",
				relayOne,
				body,
			),
		});
	};
	vi.spyOn(globalThis, "fetch").mockResolvedValue(blockedHtml());
	const blocked = await handleCodexSubscriptionRelay(await signed());
	expect(blocked.status).toBe(403);
	expect(await blocked.json()).toMatchObject({
		error: { type: "subscription_egress_blocked" },
	});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		Response.json({ error: { message: "nope" } }, { status: 403 }),
	);
	const rejected = await handleCodexSubscriptionRelay(await signed());
	expect(await rejected.json()).toMatchObject({
		error: { type: "subscription_upstream_error" },
	});
});

it("probes every path for a scheduled health check and restores recovered paths", async () => {
	const vpc = vi.fn<typeof fetch>().mockResolvedValue(blockedHtml());
	const relays = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input) =>
			new URL(String(input)).host === "relay-one.example"
				? Response.json({ models: [] })
				: Response.json(
						{ error: { type: "subscription_upstream_error" } },
						{ status: 401 },
					),
		);
	await withCodexSubscriptionEgress(vpc, async () => {
		const results = await probeCodexEgress("owner");
		expect(
			results.map(({ path, outcome, status }) => ({ path, outcome, status })),
		).toEqual([
			{ path: "vpc", outcome: "forbidden-html", status: 403 },
			{ path: "relay-1", outcome: "ok", status: 200 },
			{ path: "relay-2", outcome: "rejected", status: 401 },
		]);
		expect(String(vpc.mock.calls[0][0])).toContain("codex/models");
		// The blocked VPC path is now skipped by live requests.
		relays.mockClear();
		vpc.mockClear();
		await subscriptionFetch("owner", "wham/usage");
		expect(vpc).not.toHaveBeenCalled();
		vpc.mockResolvedValue(Response.json({ models: [] }));
		await probeCodexEgress("owner");
		relays.mockClear();
		await subscriptionFetch("owner", "wham/usage");
		expect(vpc).toHaveBeenCalledTimes(2);
		expect(relays).not.toHaveBeenCalled();
	});
});

it("lets the VPC egress keep its connections but closes them on a direct (Node) path", async () => {
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL", "");
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET", "");
	vi.stubEnv("YTIMESY_CODEX_RELAY_URL_2", "");
	vi.stubEnv("YTIMESY_CODEX_RELAY_SECRET_2", "");
	const request = () =>
		subscriptionFetch(
			"owner",
			"codex/responses",
			{
				method: "POST",
				body: "{}",
				headers: { Connection: "close", "session-id": "a".repeat(64) },
			},
			"owner-account",
		);
	const vpc = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response("data: ok\n\n"));
	await withCodexSubscriptionEgress(vpc, request);
	const sent = new Headers(vpc.mock.calls[0][1]?.headers);
	expect(sent.get("connection")).toBeNull();
	expect(sent.get("session-id")).toBe("a".repeat(64));
	expect(sent.get("authorization")).toBe("Bearer owner-token");
	const direct = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response("data: ok\n\n"));
	await request();
	expect(new Headers(direct.mock.calls[0][1]?.headers).get("connection")).toBe(
		"close",
	);
});
