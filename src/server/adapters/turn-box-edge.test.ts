import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscriptionTurnRevision } from "#/domain/subscription-turn";
import type { TurnBoxGrant } from "#/domain/turn-box-grant";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[],
	connection: null as unknown,
	subscriptionFetch: vi.fn(),
	xaiSend: vi.fn(),
	xaiFetch: vi.fn(),
}));
vi.mock("./database", () => ({
	database: () => ({ query: async () => ({ rows: mocks.rows }) }),
}));
vi.mock("./api-turns", () => ({ apiTurnLeaseFreshSql: () => "true" }));
vi.mock("./model-connections", () => ({
	loadModelConnection: async () => mocks.connection,
}));
vi.mock("../services/model-connections", () => ({
	connectionApiKey: async () => "sk-real",
}));
vi.mock("./codex-subscription-transport", () => ({
	subscriptionFetch: mocks.subscriptionFetch,
}));
vi.mock("../auth/xai-subscription", () => ({
	xaiSubscriptionFetch: (...args: unknown[]) => {
		mocks.xaiFetch(...args);
		return mocks.xaiSend;
	},
}));
// The rest of the module's imports are only loaded, never called here.
vi.mock("./agent-capacity", () => ({}));
vi.mock("./api-usage-budget", () => ({}));
vi.mock("./turn-box-edge-work", () => ({}));
vi.mock("./turn-box-port-handlers", () => ({}));
vi.mock("./turn-runner-boxes", () => ({}));

import { authorizeTurnBoxModel } from "./turn-box-edge";

const grant = {
	userId: "u",
	sessionId: "s",
	turnId: "t",
	leaseId: "l",
} as TurnBoxGrant;
let scopes = 0;
const scope = <T>(run: () => Promise<T>) => {
	scopes += 1;
	return run();
};

beforeEach(() => {
	mocks.rows = [];
	mocks.connection = null;
	scopes = 0;
	vi.clearAllMocks();
});

describe("authorizeTurnBoxModel: which route a turn is", () => {
	it("refuses a turn whose lease is gone", async () => {
		expect(await authorizeTurnBoxModel(grant, scope)).toEqual({
			kind: "refused",
			status: 401,
		});
	});

	it("serves a Codex plan turn (no connection, the plan's revision) through the Durable Object's transport", async () => {
		mocks.rows = [
			{
				connection_id: null,
				connection_revision: subscriptionTurnRevision("low"),
			},
		];
		const answer = await authorizeTurnBoxModel(grant, scope);
		expect(answer).toMatchObject({
			kind: "ok",
			connectionKind: "subscription",
			subscription: "codex",
		});
		mocks.subscriptionFetch.mockResolvedValue(new Response("ok"));
		await (
			answer as { send: (u: string, i: RequestInit) => Promise<Response> }
		).send("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
		});
		expect(mocks.subscriptionFetch).toHaveBeenCalledWith(
			"u",
			"codex/responses",
			{ method: "POST" },
		);
		// Run in its own database scope: the proxy calls it after this request's scope closed.
		expect(scopes).toBe(1);
	});

	it("refuses a turn with neither a connection nor the plan's revision", async () => {
		mocks.rows = [{ connection_id: null, connection_revision: "rev" }];
		expect(await authorizeTurnBoxModel(grant, scope)).toEqual({
			kind: "refused",
			status: 403,
		});
	});

	it("serves a Grok plan connection with the refreshing OAuth fetch, and only on api.x.ai", async () => {
		mocks.rows = [{ connection_id: "g1", connection_revision: "r" }];
		mocks.connection = {
			id: "g1",
			provider: "compatible",
			baseUrl: "https://api.x.ai/v1",
			subscription: { provider: "xai", status: "ready" },
		};
		const answer = await authorizeTurnBoxModel(grant, scope);
		expect(answer).toMatchObject({
			kind: "ok",
			subscription: "xai",
			baseUrl: "https://api.x.ai/v1",
		});
		expect(mocks.xaiFetch).toHaveBeenCalledWith("u", "g1", fetch);
		mocks.connection = {
			...(mocks.connection as object),
			baseUrl: "https://evil.example/v1",
		};
		expect(await authorizeTurnBoxModel(grant, scope)).toEqual({
			kind: "refused",
			status: 403,
		});
	});

	it("still serves an API-key connection with its decrypted key", async () => {
		mocks.rows = [{ connection_id: "c1", connection_revision: "r" }];
		mocks.connection = {
			id: "c1",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		};
		expect(await authorizeTurnBoxModel(grant, scope)).toMatchObject({
			kind: "ok",
			connectionKind: "key",
			apiKey: "sk-real",
		});
	});
});
