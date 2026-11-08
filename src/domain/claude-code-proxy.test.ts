import { describe, expect, it, vi } from "vitest";
import { issueClaudeCodeGrant } from "./claude-code-grant";
import { claudeCodeProxyRoute, proxyClaudeCode } from "./claude-code-proxy";

const secret = "s".repeat(40);
const realToken = "sk-ant-oat01-REAL-TOKEN-never-logged-0123456789";
const scope = {
	userId: "user-1",
	sessionId: "11111111-1111-4111-8111-111111111111",
	turnId: "22222222-2222-4222-8222-222222222222",
};
const edge = "https://edge.example";

async function setup(
	upstreamResponse: () => Response = () =>
		new Response('data: {"type":"message_start"}\n\n', {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"request-id": "req_1",
				"set-cookie": "a=b",
				"anthropic-ratelimit-unified-status": "allowed",
			},
		}),
) {
	const grant = await issueClaudeCodeGrant(secret, scope);
	const upstream = vi.fn(async (_url: string, _init?: RequestInit) =>
		upstreamResponse(),
	);
	const authorize = vi.fn(async () => ({
		kind: "ok" as const,
		token: realToken,
	}));
	const onUpstream = vi.fn(async () => {});
	const onUsage = vi.fn();
	const log = vi.fn();
	const call = (path: string, init: RequestInit = {}) =>
		proxyClaudeCode(
			new Request(`${edge}${path}`, {
				method: "POST",
				body: '{"model":"claude-opus-5-5","secret":"body-text"}',
				...init,
				headers: {
					authorization: `Bearer ${grant}`,
					"content-type": "application/json",
					"anthropic-version": "2023-06-01",
					"anthropic-beta": "oauth-2025-04-20",
					cookie: "session=1",
					...(init.headers as Record<string, string> | undefined),
				},
			}),
			{
				secret,
				authorize,
				onUpstream,
				onUsage,
				upstream: upstream as unknown as typeof fetch,
				log,
			},
		);
	return { grant, upstream, authorize, onUpstream, onUsage, log, call };
}

describe("Claude Code proxy", () => {
	it("allows only the model API's paths", () => {
		const route = (method: string, path: string) =>
			claudeCodeProxyRoute(method, new URL(`${edge}${path}`));
		expect(route("POST", "/claude-code/v1/messages?beta=true")).toBe(
			"messages",
		);
		expect(route("POST", "/claude-code/v1/messages")).toBe("messages");
		expect(
			route("POST", "/claude-code/v1/messages/count_tokens?beta=true"),
		).toBe("count-tokens");
		expect(route("HEAD", "/claude-code/api/hello")).toBe("hello");
		expect(route("GET", "/claude-code/v1/messages")).toBeNull();
		expect(route("POST", "/claude-code/v1/messages?x=1")).toBeNull();
		expect(route("POST", "/claude-code/api/oauth/profile")).toBeNull();
		expect(route("POST", "/claude-code/v1/files")).toBeNull();
	});

	it("swaps the grant for the real token and streams the answer back", async () => {
		const { call, upstream, authorize } = await setup();
		const response = await call("/claude-code/v1/messages?beta=true");
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("message_start");
		expect(response.headers.get("request-id")).toBe("req_1");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("anthropic-ratelimit-unified-status")).toBe(
			"allowed",
		);
		expect(authorize).toHaveBeenCalledWith(
			expect.objectContaining({ turnId: scope.turnId, userId: scope.userId }),
		);
		const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
		expect(init.redirect).toBe("manual");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${realToken}`);
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(headers.get("cookie")).toBeNull();
	});

	it("answers the reachability probe without credentials or upstream", async () => {
		const { upstream } = await setup();
		const response = await proxyClaudeCode(
			new Request(`${edge}/claude-code/api/hello`, { method: "HEAD" }),
			{ secret, authorize: vi.fn(), upstream: upstream as never },
		);
		expect(response.status).toBe(200);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("refuses unknown paths and logs only the path", async () => {
		const { call, upstream, log } = await setup();
		const response = await call("/claude-code/api/oauth/profile?token=x");
		expect(response.status).toBe(404);
		expect(upstream).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"Claude Code proxy refused an unknown path.",
			{ method: "POST", path: "/claude-code/api/oauth/profile" },
		);
	});

	it("refuses a missing or forged grant before authorizing", async () => {
		const { authorize, upstream } = await setup();
		const response = await proxyClaudeCode(
			new Request(`${edge}/claude-code/v1/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${realToken}` },
				body: "{}",
			}),
			{ secret, authorize, upstream: upstream as never },
		);
		expect(response.status).toBe(401);
		expect(authorize).not.toHaveBeenCalled();
		expect(upstream).not.toHaveBeenCalled();
	});

	it("refuses a turn that ended or hit its cap, without retries", async () => {
		const { call, authorize, upstream } = await setup();
		authorize.mockResolvedValueOnce({ kind: "refused", status: 401 } as never);
		expect((await call("/claude-code/v1/messages")).status).toBe(401);
		authorize.mockResolvedValueOnce({ kind: "refused", status: 429 } as never);
		const capped = await call("/claude-code/v1/messages");
		expect(capped.status).toBe(429);
		expect(capped.headers.get("x-should-retry")).toBe("false");
		expect(upstream).not.toHaveBeenCalled();
	});

	it("returns a permission denial without marking the saved login invalid", async () => {
		const denied = await setup(() =>
			Response.json(
				{ error: { type: "permission_error", message: "Model access denied" } },
				{ status: 403 },
			),
		);
		expect((await denied.call("/claude-code/v1/messages")).status).toBe(403);
		expect(denied.onUpstream).not.toHaveBeenCalled();
		expect(denied.log).toHaveBeenCalledWith(
			"Claude Code upstream permission denied; saved login retained.",
			{ status: 403, route: "messages" },
		);
	});
	it("does not invalidate a saved login from a token-counting probe", async () => {
		const probe = await setup(() =>
			Response.json(
				{ error: { type: "authentication_error" } },
				{ status: 401 },
			),
		);
		expect(
			(await probe.call("/claude-code/v1/messages/count_tokens")).status,
		).toBe(401);
		expect(probe.onUpstream).not.toHaveBeenCalled();
	});
	it("reports a refused token and a spent plan", async () => {
		const refused = await setup(() => new Response("{}", { status: 401 }));
		expect((await refused.call("/claude-code/v1/messages")).status).toBe(401);
		expect(refused.onUpstream).toHaveBeenCalledWith(
			expect.objectContaining({ userId: scope.userId }),
			{ kind: "refused", status: 401 },
		);
		const spent = await setup(
			() =>
				new Response("{}", {
					status: 429,
					headers: {
						"anthropic-ratelimit-unified-status": "rejected",
						"anthropic-ratelimit-unified-reset": "1900000000",
					},
				}),
		);
		await spent.call("/claude-code/v1/messages");
		expect(spent.onUpstream).toHaveBeenCalledWith(expect.anything(), {
			kind: "usage-limit",
			resetsAt: 1_900_000_000_000,
		});
	});

	it("never follows an upstream redirect", async () => {
		const { call } = await setup(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://elsewhere.example" },
				}),
		);
		expect((await call("/claude-code/v1/messages")).status).toBe(502);
	});

	it("never logs a token, a grant or a body", async () => {
		const { call, log, grant } = await setup(
			() => new Response("{}", { status: 403 }),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await call("/claude-code/v1/messages");
		await call("/claude-code/v2/unknown");
		const logged = JSON.stringify([log.mock.calls, warn.mock.calls]);
		for (const secretText of [realToken, grant, "body-text"])
			expect(logged).not.toContain(secretText);
		warn.mockRestore();
	});

	it("hands the plan's usage headers to onUsage without holding the response", async () => {
		const { call, onUsage } = await setup(
			() =>
				new Response("{}", {
					status: 200,
					headers: {
						"anthropic-ratelimit-unified-status": "allowed",
						"anthropic-ratelimit-unified-reset": "1900000000",
						"anthropic-ratelimit-unified-5h-utilization": "0.42",
						"anthropic-ratelimit-unified-5h-reset": "1900000000",
						"anthropic-ratelimit-unified-7d-utilization": "0.1",
						"anthropic-ratelimit-unified-7d-reset": "1900500000",
					},
				}),
		);
		const response = await call("/claude-code/v1/messages");
		expect(response.status).toBe(200);
		expect(
			response.headers.get("anthropic-ratelimit-unified-5h-utilization"),
		).toBe("0.42");
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage.mock.calls[0]?.[0]).toMatchObject({ userId: scope.userId });
		expect(onUsage.mock.calls[0]?.[1]).toMatchObject({
			status: "allowed",
			windows: [
				{ id: "5h", usedPercent: 42, resetsAt: 1_900_000_000_000 },
				{ id: "7d", usedPercent: 10, resetsAt: 1_900_500_000_000 },
			],
		});
	});

	it("still answers when recording usage throws, and skips responses without the headers", async () => {
		const quiet = await setup(() => new Response("{}", { status: 200 }));
		await quiet.call("/claude-code/v1/messages");
		expect(quiet.onUsage).not.toHaveBeenCalled();
		const throwing = await setup();
		throwing.onUsage.mockImplementation(() => {
			throw new Error("boom");
		});
		expect((await throwing.call("/claude-code/v1/messages")).status).toBe(200);
	});
});
