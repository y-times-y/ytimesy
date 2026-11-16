import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { generateText } from "ai";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import { XaiSubscriptionUnavailable } from "../src/domain/api-turn-failure";
import { failoverReason } from "../src/domain/model-failover-reason";
import { connectedLanguageModel } from "../src/server/adapters/api-model";
import {
	listModelConnections,
	loadModelConnection,
} from "../src/server/adapters/model-connections";
import {
	advanceXaiDeviceLogin,
	readXaiDeviceLogin,
	startXaiDeviceLogin,
} from "../src/server/auth/xai-device-login";
import {
	disconnectXaiSubscription,
	loadXaiSubscription,
	xaiSubscriptionAccessToken,
} from "../src/server/auth/xai-subscription";
import { connectionModelAccess } from "../src/server/services/model-connections";

/**
 * SuperGrok sign-in and use against a fake xAI (auth.x.ai and api.x.ai
 * answered in-process; nothing reaches xAI) and a real Postgres schema.
 */
let db: PGlite;
vi.mock("../src/server/adapters/database", () => {
	const query = (sql: string, params?: unknown[]) => db.query(sql, params);
	return {
		database: () => ({
			query,
			connect: async () => ({ query, release: () => {} }),
		}),
	};
});
vi.mock("../src/server/config", () => {
	const serverConfig = () => ({
		BETTER_AUTH_SECRET: "fixture-secret-longer-than-thirty-two-characters",
	});
	return {
		serverConfig,
		databaseConfig: serverConfig,
		vaultConfig: serverConfig,
	};
});
// Model discovery uses the stubbed global fetch instead of a real socket.
vi.mock("../src/server/adapters/model-endpoint", () => ({
	modelEndpointTransport: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			globalThis.fetch(input, init),
		close: async () => {},
	}),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values ('alice'),('bob');",
	);
	for (const file of [
		"20260927183000_model_connections.sql",
		"20261101140000_xai_subscription.sql",
		"20261102150000_xai_plan_usage.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
}, 120_000);
afterAll(() => db.close());

beforeEach(async () => {
	vi.stubEnv("YTIMESY_XAI_SUBSCRIPTION_ENABLED", "1");
	await db.exec("delete from model_connection; delete from xai_device_login;");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

type Handler = (body: URLSearchParams, request: Request) => Response;

/** The fake xAI: answers each URL it knows and records every request. */
function fakeXai(routes: Record<string, Handler | Handler[]>) {
	const requests: { url: string; body: URLSearchParams; auth: string }[] = [];
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = request.url.split("?")[0];
		const body = new URLSearchParams(
			request.method === "POST" ? await request.clone().text() : "",
		);
		requests.push({
			url,
			body,
			auth: request.headers.get("authorization") ?? "",
		});
		const route = routes[url];
		const handler = Array.isArray(route) ? route.shift() : route;
		if (!handler) throw new Error(`Unexpected request to ${url}`);
		return handler(body, request);
	});
	vi.stubGlobal("fetch", fetch);
	return requests;
}

const DEVICE = "https://auth.x.ai/oauth2/device/code";
const TOKEN = "https://auth.x.ai/oauth2/token";
const MODELS = "https://api.x.ai/v1/models";
const RESPONSES = "https://api.x.ai/v1/responses";

const deviceCode = () =>
	Response.json({
		device_code: "device-secret",
		user_code: "WXYZ-1234",
		verification_uri: "https://accounts.x.ai/device",
		verification_uri_complete: "https://accounts.x.ai/device?code=WXYZ-1234",
		expires_in: 600,
		interval: 5,
	});
const oauthError = (error: string) => () =>
	Response.json({ error }, { status: 400 });
const tokens =
	(access = "access-1", refresh: string | null = "refresh-1") =>
	() =>
		Response.json({
			access_token: access,
			...(refresh ? { refresh_token: refresh } : {}),
			expires_in: 21_600,
		});

/** Signs alice in through the device flow; returns her connection's id. */
async function signIn(models: Handler = () => Response.json({ data: [] })) {
	fakeXai({ [DEVICE]: deviceCode, [TOKEN]: tokens(), [MODELS]: models });
	await startXaiDeviceLogin("alice");
	expect(await advanceXaiDeviceLogin("alice")).toEqual({
		status: "connected",
	});
	const row = (await listModelConnections("alice")).find(
		(connection) => connection.subscription,
	);
	if (!row) throw new Error("No SuperGrok connection");
	return row;
}

it("starts device sign-in with xAI's public client, scope and the ytimesy referrer", async () => {
	const requests = fakeXai({ [DEVICE]: deviceCode });
	expect(await startXaiDeviceLogin("alice")).toEqual({
		status: "pending",
		userCode: "WXYZ-1234",
		verificationUrl: "https://accounts.x.ai/device?code=WXYZ-1234",
	});
	expect(requests).toHaveLength(1);
	expect(Object.fromEntries(requests[0].body)).toEqual({
		client_id: "b1a00492-073a-47ea-816f-4c329264a828",
		scope: "openid profile email offline_access grok-cli:access api:access",
		referrer: "ytimesy",
	});
	// The device code is sealed, never stored in the clear.
	const stored = await db.query<{ sealed_login: string }>(
		"select sealed_login from xai_device_login where user_id='alice'",
	);
	expect(stored.rows[0].sealed_login).not.toContain("device-secret");
	expect(await readXaiDeviceLogin("alice")).toMatchObject({
		status: "pending",
	});
	// A second start reuses the waiting code.
	await startXaiDeviceLogin("alice");
	expect(requests).toHaveLength(1);
});

it("polls at xAI's interval, slows down when asked, and stops on a denial", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(1_000_000);
	const requests = fakeXai({
		[DEVICE]: deviceCode,
		[TOKEN]: [
			oauthError("authorization_pending"),
			oauthError("slow_down"),
			oauthError("access_denied"),
		],
	});
	await startXaiDeviceLogin("alice");
	expect(await advanceXaiDeviceLogin("alice")).toMatchObject({
		status: "pending",
	});
	const poll = requests[1];
	expect(poll.url).toBe(TOKEN);
	expect(Object.fromEntries(poll.body)).toEqual({
		grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		client_id: "b1a00492-073a-47ea-816f-4c329264a828",
		device_code: "device-secret",
	});
	// Before the interval (5 s + 3 s margin) passes, xAI is not asked again.
	vi.setSystemTime(1_007_000);
	await advanceXaiDeviceLogin("alice");
	expect(requests).toHaveLength(2);
	vi.setSystemTime(1_008_000);
	await advanceXaiDeviceLogin("alice");
	expect(requests).toHaveLength(3);
	// slow_down: 10 s + 3 s from now.
	vi.setSystemTime(1_020_000);
	await advanceXaiDeviceLogin("alice");
	expect(requests).toHaveLength(3);
	vi.setSystemTime(1_021_000);
	expect(await advanceXaiDeviceLogin("alice")).toEqual({
		status: "failed",
		message: "xAI sign-in was declined. Sign in again.",
	});
	expect(await readXaiDeviceLogin("alice")).toEqual({ status: "none" });
	expect(await listModelConnections("alice")).toEqual([]);
});

it("seals approved tokens into a SuperGrok connection with xAI's listed Grok models", async () => {
	const connection = await signIn(() =>
		Response.json({
			data: [{ id: "grok-4.7" }, { id: "grok-imagine" }],
		}),
	);
	expect(connection).toMatchObject({
		provider: "compatible",
		label: "Grok plan",
		baseUrl: "https://api.x.ai/v1",
		subscription: { provider: "xai", status: "ready" },
	});
	expect(connection.models.map((model) => model.id)).toEqual([
		"grok-4.7",
		"grok-imagine",
	]);
	const stored = await loadModelConnection("alice", connection.id);
	expect(stored?.sealedCredential).not.toContain("access-1");
	expect(stored?.sealedCredential).not.toContain("refresh-1");
	expect(await loadXaiSubscription("alice")).toEqual({
		status: "ready",
		connectionId: connection.id,
		modelCount: 2,
	});
	// Another user cannot read it.
	expect(await loadModelConnection("bob", connection.id)).toBeNull();
	await expect(
		xaiSubscriptionAccessToken("bob", connection.id),
	).rejects.toThrow();
});

it("falls back to the catalog's Grok models when xAI's list is unavailable", async () => {
	const connection = await signIn(
		() => new Response("forbidden", { status: 403 }),
	);
	expect(connection.models.map((model) => model.id)).toEqual([
		"grok-4.7",
		"grok-4.6",
	]);
});

it("refuses a sign-in without a refresh token", async () => {
	fakeXai({ [DEVICE]: deviceCode, [TOKEN]: tokens("access-1", null) });
	await startXaiDeviceLogin("alice");
	expect(await advanceXaiDeviceLogin("alice")).toMatchObject({
		status: "failed",
	});
	expect(await listModelConnections("alice")).toEqual([]);
});

it("refreshes an expiring token with the rotation kept and the revision unchanged", async () => {
	const connection = await signIn();
	vi.useFakeTimers({ toFake: ["Date"] });
	// Six hours on: inside the refresh window.
	vi.setSystemTime(Date.now() + 21_000_000);
	const requests = fakeXai({
		[TOKEN]: [
			tokens("access-2", "refresh-2"),
			tokens("access-3", null),
			tokens("access-4", "refresh-4"),
		],
	});
	expect((await xaiSubscriptionAccessToken("alice", connection.id)).token).toBe(
		"access-2",
	);
	expect(Object.fromEntries(requests[0].body)).toEqual({
		grant_type: "refresh_token",
		refresh_token: "refresh-1",
		client_id: "b1a00492-073a-47ea-816f-4c329264a828",
	});
	// Fresh now: no second refresh.
	await xaiSubscriptionAccessToken("alice", connection.id);
	expect(requests).toHaveLength(1);
	// A 401 on the stored token refreshes with the rotated refresh token; xAI
	// may omit a new one.
	await xaiSubscriptionAccessToken("alice", connection.id, "access-2");
	expect(requests[1].body.get("refresh_token")).toBe("refresh-2");
	// Without a new refresh token, the previous one is kept.
	expect(
		(await xaiSubscriptionAccessToken("alice", connection.id, "access-3"))
			.token,
	).toBe("access-4");
	expect(requests[2].body.get("refresh_token")).toBe("refresh-2");
	// A 401 on a token another step already replaced spends nothing.
	expect(
		(await xaiSubscriptionAccessToken("alice", connection.id, "access-3"))
			.token,
	).toBe("access-4");
	expect(requests).toHaveLength(3);
	expect((await loadModelConnection("alice", connection.id))?.revision).toBe(
		connection.revision,
	);
});

it("marks the connection for reconnecting when xAI rejects the refresh", async () => {
	const connection = await signIn();
	fakeXai({ [TOKEN]: oauthError("invalid_grant") });
	const failure = await xaiSubscriptionAccessToken(
		"alice",
		connection.id,
		"access-1",
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(XaiSubscriptionUnavailable);
	expect(failoverReason(failure)).toBe("plan-access");
	expect(await loadXaiSubscription("alice")).toMatchObject({
		status: "reconnect",
	});
	// No further xAI requests until the user signs in again.
	const requests = fakeXai({});
	await expect(
		xaiSubscriptionAccessToken("alice", connection.id),
	).rejects.toBeInstanceOf(XaiSubscriptionUnavailable);
	expect(requests).toHaveLength(0);
	// Signing in again makes it ready, keeping the connection's id.
	expect((await signIn()).id).toBe(connection.id);
});

it("routes a turn's model calls to api.x.ai with the user's bearer, not a key", async () => {
	const connection = await signIn();
	const stored = await loadModelConnection("alice", connection.id);
	if (!stored) throw new Error("Missing connection");
	const requests = fakeXai({
		[RESPONSES]: () => new Response("plan not entitled", { status: 403 }),
	});
	const access = await connectionModelAccess("alice", stored, (input, init) =>
		globalThis.fetch(input, init),
	);
	expect(access.apiKey).not.toBe("access-1");
	const failure = await generateText({
		model: connectedLanguageModel(
			{ ...stored, apiKey: access.apiKey, modelId: "grok-4.7" },
			access.fetch,
		),
		prompt: "hello",
		maxRetries: 0,
	}).catch((error: unknown) => error);
	expect(requests[0].url).toBe(RESPONSES);
	expect(requests[0].auth).toBe("Bearer access-1");
	// A 403 marks the plan ineligible and moves the turn to another route.
	expect(failoverReason(failure)).toBe("plan-refused");
	expect(await loadXaiSubscription("alice")).toMatchObject({
		status: "not-eligible",
	});
});

it("refreshes once on a 401 and retries the request with the new token", async () => {
	const connection = await signIn();
	const stored = await loadModelConnection("alice", connection.id);
	if (!stored) throw new Error("Missing connection");
	const requests = fakeXai({
		[MODELS]: [
			() => new Response("expired", { status: 401 }),
			() => Response.json({ data: [] }),
		],
		[TOKEN]: tokens("access-2", "refresh-2"),
	});
	const access = await connectionModelAccess("alice", stored, (input, init) =>
		globalThis.fetch(input, init),
	);
	const response = await access.fetch(MODELS, {
		headers: { authorization: `Bearer ${access.apiKey}` },
	});
	expect(response.status).toBe(200);
	expect(requests.map((row) => [row.url, row.auth])).toEqual([
		[MODELS, "Bearer access-1"],
		[TOKEN, ""],
		[MODELS, "Bearer access-2"],
	]);
});

it("shows and serves nothing while the feature switch is off", async () => {
	const connection = await signIn();
	vi.stubEnv("YTIMESY_XAI_SUBSCRIPTION_ENABLED", "");
	expect(await listModelConnections("alice")).toEqual([]);
	expect(await loadModelConnection("alice", connection.id)).toBeNull();
	expect(await loadXaiSubscription("alice")).toBeUndefined();
	expect(await readXaiDeviceLogin("alice")).toEqual({ status: "none" });
	await expect(startXaiDeviceLogin("alice")).rejects.toThrow("not available");
	await expect(advanceXaiDeviceLogin("alice")).rejects.toThrow("not available");
	vi.stubEnv("YTIMESY_XAI_SUBSCRIPTION_ENABLED", "1");
	await disconnectXaiSubscription("alice");
	expect(await loadXaiSubscription("alice")).toEqual({
		status: "disconnected",
	});
});
