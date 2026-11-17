import { describe, expect, it, vi } from "vitest";
import { fakeEdge } from "../edge/turn-box-fake-edge";
import { grantRotatingFetch, TurnBoxEdgeClient } from "./turn-box-client";

const BASE = "https://edge.test/box/v1/model";

describe("the model SDK's grant-rotating fetch", () => {
	it("sends the CURRENT grant on every request, in every provider's key slot", async () => {
		let grant = "ytbg1.first";
		const upstream = vi.fn(
			async (_input: unknown, _init?: RequestInit) => new Response("ok"),
		);
		const fetcher = grantRotatingFetch({
			grant: () => grant,
			baseUrl: BASE,
			fetch: upstream as unknown as typeof fetch,
		});
		await fetcher(`${BASE}/responses`, {
			method: "POST",
			headers: {
				authorization: "Bearer placeholder",
				"x-api-key": "placeholder",
			},
			body: "{}",
		});
		grant = "ytbg1.second";
		await fetcher(`${BASE}/messages`, { method: "POST", body: "{}" });
		const sent = upstream.mock.calls.map(
			([, init]) => new Headers(init?.headers),
		);
		expect(sent[0]?.get("authorization")).toBe("Bearer ytbg1.first");
		expect(sent[0]?.get("x-api-key")).toBe("ytbg1.first");
		expect(sent[0]?.get("x-goog-api-key")).toBe("ytbg1.first");
		// The grant rotated between the two calls; the SDK was built once.
		expect(sent[1]?.get("authorization")).toBe("Bearer ytbg1.second");
		expect(upstream.mock.calls[1]?.[1]?.redirect).toBe("manual");
	});

	it("never sends the grant to a host or path outside the edge's model proxy", async () => {
		const upstream = vi.fn();
		const fetcher = grantRotatingFetch({
			grant: () => "ytbg1.secret",
			baseUrl: BASE,
			fetch: upstream as unknown as typeof fetch,
		});
		for (const url of [
			"https://api.openai.com/v1/responses",
			"https://evil.test/box/v1/model/responses",
			"https://edge.test/box/v1/checkpoint",
			"https://edge.test/box/v1/modelx/responses",
		])
			expect(() => fetcher(url, { method: "POST" })).toThrow(
				/only sends model requests/,
			);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("follows the turn's renewed grant (renewal replaces it) through a real session", async () => {
		const edge = await fakeEdge();
		edge.queue.push({ ...edge.row });
		const seen: string[] = [];
		const client = new TurnBoxEdgeClient({
			edgeUrl: "https://edge.test",
			identity: edge.identity,
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				if (new URL(String(input)).pathname.startsWith("/box/v1/model/"))
					seen.push(new Headers(init?.headers).get("authorization") ?? "");
				return edge.fetchEdge(input, init);
			}) as typeof fetch,
			now: () => edge.state.now,
		});
		const session = await client.claim();
		if (!session) throw new Error("no turn");
		const sdk = session.modelSdkSettings();
		expect(sdk.baseUrl).toBe(BASE);
		expect(sdk.apiKey).not.toBe(session.grant);
		const before = session.grant;
		await sdk.fetch(`${BASE}/responses`, {
			method: "POST",
			body: "{}",
			headers: { "content-length": "2" },
		});
		// Past half its life, a renewal returns a replacement grant.
		edge.state.now += 8 * 60_000;
		expect(await session.renew()).toBe("renewed");
		expect(session.grant).not.toBe(before);
		await sdk.fetch(`${BASE}/responses`, {
			method: "POST",
			body: "{}",
			headers: { "content-length": "2" },
		});
		expect(seen).toEqual([`Bearer ${before}`, `Bearer ${session.grant}`]);
	});
});
