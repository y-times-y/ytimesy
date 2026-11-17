import { describe, expect, it, vi } from "vitest";
import { generateTurnBoxKeyPair, issueTurnBoxGrant } from "./turn-box-grant";
import {
	proxyTurnBoxModel,
	TURN_BOX_MODEL_ORIGINS,
	type TurnBoxModelAuthorization,
	turnBoxModelPath,
} from "./turn-box-model-proxy";

const scope = {
	userId: "user-1",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
	leaseId: "33333333-3333-4333-8333-333333333333",
	boxId: "box-a",
};
const ok = (
	over: Partial<Extract<TurnBoxModelAuthorization, { kind: "ok" }>> = {},
) =>
	({
		kind: "ok",
		connectionKind: "key",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "sk-real-key",
		...over,
	}) as TurnBoxModelAuthorization;

const sentHeaders = (upstream: { mock: { calls: unknown[][] } }) =>
	new Headers(((upstream.mock.calls[0] ?? [])[1] as RequestInit).headers);

async function setup(
	authorization: TurnBoxModelAuthorization | Error,
	path = "chat/completions",
) {
	const keys = await generateTurnBoxKeyPair();
	const grant = await issueTurnBoxGrant(keys.privateKey, scope);
	const upstream = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response("data: hi\n\n", {
				headers: { "content-type": "text/event-stream", "set-cookie": "x=1" },
			}),
	);
	const run = (headers: Record<string, string> = {}, method = "POST") =>
		proxyTurnBoxModel(
			new Request(`https://edge.test/box/v1/model/${path}`, {
				method,
				headers: {
					authorization: `Bearer ${grant}`,
					"content-type": "application/json",
					cookie: "secret",
					...headers,
				},
				body: method === "POST" ? JSON.stringify({ model: "m" }) : undefined,
			}),
			{
				publicKey: keys.publicKey,
				authorize: async () => {
					if (authorization instanceof Error) throw authorization;
					return authorization;
				},
				upstream: upstream as unknown as typeof fetch,
				log: () => undefined,
			},
		);
	return { run, upstream, keys, grant };
}

describe("turn box model proxy", () => {
	it("streams to the official origin with the real key, forwarding only allowlisted headers", async () => {
		const { run, upstream } = await setup(ok());
		const response = await run();
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("data: hi\n\n");
		expect(response.headers.get("set-cookie")).toBeNull();
		const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer sk-real-key");
		expect(headers.get("cookie")).toBeNull();
		expect(init.redirect).toBe("manual");
	});

	it("uses each provider's key header", async () => {
		const anthropic = await setup(
			ok({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" }),
			"messages",
		);
		await anthropic.run();
		expect(sentHeaders(anthropic.upstream).get("x-api-key")).toBe(
			"sk-real-key",
		);
		const google = await setup(
			ok({
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			}),
			"models/gemini-x:streamGenerateContent",
		);
		await google.run();
		expect(sentHeaders(google.upstream).get("x-goog-api-key")).toBe(
			"sk-real-key",
		);
	});

	it("refuses origins outside the official allowlist, without calling upstream", async () => {
		for (const baseUrl of [
			"https://evil.example/v1",
			"http://api.openai.com/v1",
			"https://api.openai.com.evil.example/v1",
			"https://user:pw@api.openai.com/v1",
			"https://api.openai.com:8443/v1",
		]) {
			const { run, upstream } = await setup(ok({ baseUrl }));
			expect((await run()).status).toBe(403);
			expect(upstream).not.toHaveBeenCalled();
		}
		expect(TURN_BOX_MODEL_ORIGINS.has("https://api.openai.com")).toBe(true);
		expect(TURN_BOX_MODEL_ORIGINS.size).toBe(4);
	});

	it("refuses non-API-key connections and refused authorizations", async () => {
		for (const kind of ["subscription", "codex", "claude"]) {
			const { run, upstream } = await setup(ok({ connectionKind: kind }));
			expect((await run()).status).toBe(403);
			expect(upstream).not.toHaveBeenCalled();
		}
		const stale = await setup({ kind: "refused", status: 401 });
		expect((await stale.run()).status).toBe(401);
		expect(stale.upstream).not.toHaveBeenCalled();
		const down = await setup(new Error("db down"));
		expect((await down.run()).status).toBe(503);
	});

	it("reserves the request's tokens from its size, refusing a spent budget or an undeclared size", async () => {
		const keys = await generateTurnBoxKeyPair();
		const grant = await issueTurnBoxGrant(keys.privateKey, scope);
		const upstream = vi.fn(async () => new Response("ok"));
		const run = (reserve: () => Promise<boolean>, length?: string) =>
			proxyTurnBoxModel(
				new Request("https://edge.test/box/v1/model/chat/completions", {
					method: "POST",
					headers: {
						authorization: `Bearer ${grant}`,
						...(length ? { "content-length": length } : {}),
					},
					body: "{}",
				}),
				{
					publicKey: keys.publicKey,
					authorize: async () => ok(),
					reserve,
					upstream: upstream as unknown as typeof fetch,
					log: () => undefined,
				},
			);
		const reserved = vi.fn(async () => true);
		expect((await run(reserved, "2")).status).toBe(200);
		expect(reserved).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: scope.turnId }),
			2,
		);
		expect((await run(async () => false, "2")).status).toBe(429);
		expect((await run(async () => true)).status).toBe(411);
		expect(upstream).toHaveBeenCalledOnce();
	});

	it("refuses a bad or forged grant, wrong method and unsafe paths", async () => {
		const { run, upstream } = await setup(ok());
		expect((await run({ authorization: "Bearer ytbg1.x.y" })).status).toBe(401);
		expect((await run({}, "GET")).status).toBe(404);
		for (const path of [
			"../admin",
			"%2e%2e/admin",
			"a//b",
			"a%2Fb",
			"a?key=1",
			"a@b",
		]) {
			const url = new URL(`https://edge.test/box/v1/model/${path}`);
			expect(turnBoxModelPath(url)).toBeNull();
		}
		expect(
			turnBoxModelPath(
				new URL("https://edge.test/box/v1/model/m:stream?alt=sse"),
			),
		).toBe("/m:stream?alt=sse");
		expect(
			turnBoxModelPath(new URL("https://edge.test/box/v1/model/m?key=abc")),
		).toBeNull();
		expect(upstream).not.toHaveBeenCalled();
	});
});
