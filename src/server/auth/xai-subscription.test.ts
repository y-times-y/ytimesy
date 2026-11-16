import { PGlite } from "@electric-sql/pglite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { XaiSubscriptionUnavailable } from "#/domain/api-turn-failure";
import { XAI_REFUSAL_COOLDOWN_MS } from "#/domain/xai-subscription";
import {
	saveXaiSubscription,
	xaiSubscriptionAccessToken,
	xaiSubscriptionFetch,
} from "./xai-subscription";

const holder = vi.hoisted(() => {
	process.env.BETTER_AUTH_SECRET = "b".repeat(40);
	process.env.TOKEN_VAULT_KEY = "v".repeat(40);
	return { query: vi.fn(), connect: vi.fn() };
});
vi.mock("../adapters/database", () => ({ database: () => holder }));

let db: PGlite;
let connectionId: string;
/** xAI's token endpoint (auth.x.ai), answered per test. */
let oauth: ReturnType<typeof vi.fn<typeof fetch>>;
let warn: MockInstance<typeof console.warn>;

const API = "https://api.x.ai/v1/responses";
const json = (status: number, body: unknown) =>
	new Response(typeof body === "string" ? body : JSON.stringify(body), {
		status,
	});
const status = async () =>
	(await db.query<{ status: string }>("select status from model_connection"))
		.rows[0]?.status;
const transitions = () =>
	warn.mock.calls
		.filter(([message]) => message === "Grok plan connection status changed.")
		.map(([, detail]) => detail as Record<string, unknown>)
		.filter((detail) => detail.cause !== "signed in");
/** A model API that answers each request with the next status in turn. */
const api = (...answers: Array<[number, unknown]>) => {
	const transport = vi.fn<typeof fetch>(async () => {
		const [code, body] = answers.shift() ?? [200, {}];
		return json(code, body);
	});
	return transport;
};
const send = (fetch: typeof globalThis.fetch) =>
	fetch(API, { method: "POST", body: "{}" });
const bearer = (transport: ReturnType<typeof api>, call: number) =>
	new Headers(transport.mock.calls[call]?.[1]?.headers).get("authorization");

async function signIn(expiresIn: number, status = "ready") {
	connectionId = await saveXaiSubscription(
		holder,
		"u1",
		{
			access_token: "access-1",
			refresh_token: "refresh-1",
			expires_in: expiresIn,
		},
		[],
	);
	await db.query("update model_connection set status=$1", [status]);
}

// One database for the file (starting PGlite is the slow part); each test
// starts from an empty table.
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`
	 create table model_connection(id text primary key,user_id text not null,provider text,
	   label text,base_url text,sealed_credential text,models jsonb,revision text,
	   kind text not null default 'key',status text not null default 'ready',
	   updated_at timestamptz not null default now(),plan_usage jsonb,plan_usage_at timestamptz);`);
}, 60_000);
afterAll(async () => {
	await db.close();
});

beforeEach(async () => {
	await db.exec("delete from model_connection");
	holder.query.mockImplementation(async (sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
	// One PGlite connection serves the transaction (it runs one at a time).
	holder.connect.mockImplementation(async () => ({
		query: (sql: string, values?: unknown[]) => db.query(sql, values),
		release: () => {},
	}));
	oauth = vi.fn<typeof fetch>(async () =>
		json(200, {
			access_token: "access-2",
			refresh_token: "refresh-2",
			expires_in: 21_600,
		}),
	);
	vi.stubGlobal("fetch", oauth);
	warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("a 403 from xAI", () => {
	it("does not mark the plan for a usage-limit refusal that names the subscription", async () => {
		await signIn(21_600);
		const transport = api([
			403,
			{
				code: "The caller does not have permission to execute the specified operation",
				error:
					"You have either run out of available resources or do not have an active Grok subscription. Manage your subscription at https://grok.com/?_s=usage or subscribe at https://grok.com/supergrok.",
			},
		]);
		const error = await send(
			xaiSubscriptionFetch("u1", connectionId, transport),
		).catch((cause) => cause);
		expect(error).toBeInstanceOf(XaiSubscriptionUnavailable);
		expect(error.reason).toBe("usage-limit");
		expect(await status()).toBe("ready");
		// What xAI said is logged for the next diagnosis.
		expect(warn).toHaveBeenCalledWith(
			"xAI refused a Grok request.",
			expect.objectContaining({
				verdict: "usage-limit",
				body: expect.stringContaining("run out of available resources"),
			}),
		);
	});

	it("marks an explicit plan refusal and logs the transition with xAI's words", async () => {
		await signIn(21_600);
		const transport = api([403, { error: "Your plan does not include Grok." }]);
		await expect(
			send(xaiSubscriptionFetch("u1", connectionId, transport)),
		).rejects.toMatchObject({ reason: "not-eligible" });
		expect(await status()).toBe("not-eligible");
		expect(transitions()).toEqual([
			expect.objectContaining({
				from: "ready",
				to: "not-eligible",
				httpStatus: 403,
				body: expect.stringContaining("does not include Grok"),
			}),
		]);
	});

	it("is cleared by the next request that works, in the same turn", async () => {
		await signIn(21_600);
		const fetch = xaiSubscriptionFetch(
			"u1",
			connectionId,
			api([403, { error: "Your plan does not include Grok." }], [200, {}]),
		);
		await send(fetch).catch(() => {});
		expect(await status()).toBe("not-eligible");
		expect((await send(fetch)).status).toBe(200);
		expect(await status()).toBe("ready");
	});
});

describe("a refused connection tried again", () => {
	it("waits out the cooldown, then a request that works makes it ready", async () => {
		await signIn(21_600, "not-eligible");
		await expect(
			xaiSubscriptionAccessToken("u1", connectionId),
		).rejects.toMatchObject({ reason: "not-eligible" });
		await db.query(
			`update model_connection set updated_at=now()-interval '${XAI_REFUSAL_COOLDOWN_MS + 60_000} milliseconds'`,
		);
		const transport = api([200, {}]);
		expect(
			(await send(xaiSubscriptionFetch("u1", connectionId, transport))).status,
		).toBe(200);
		expect(await status()).toBe("ready");
		expect(transitions()).toEqual([
			expect.objectContaining({ from: "not-eligible", to: "ready" }),
		]);
	});
});

describe("a 401 from xAI", () => {
	it("refreshes once, retries, and saves the rotated pair", async () => {
		await signIn(21_600);
		const transport = api([401, {}], [200, {}]);
		expect(
			(await send(xaiSubscriptionFetch("u1", connectionId, transport))).status,
		).toBe(200);
		expect(oauth).toHaveBeenCalledTimes(1);
		expect(String(oauth.mock.calls[0]?.[1]?.body)).toContain(
			"refresh_token=refresh-1",
		);
		expect(bearer(transport, 1)).toBe("Bearer access-2");
		const next = await xaiSubscriptionAccessToken("u1", connectionId);
		expect(next.token).toBe("access-2");
		expect(await status()).toBe("ready");
	});

	it("never asks for sign-in when the token was just refreshed", async () => {
		await signIn(21_600);
		const transport = api([401, {}], [401, { error: "unauthorized" }]);
		await expect(
			send(xaiSubscriptionFetch("u1", connectionId, transport)),
		).rejects.toMatchObject({ reason: "unavailable" });
		expect(await status()).toBe("ready");
	});

	it("does not spend the refresh token when another step already replaced the rejected one", async () => {
		await signIn(21_600);
		// A turn still holds access-1 while another step rotated the pair.
		const stale = xaiSubscriptionFetch("u1", connectionId, api([200, {}]));
		await send(stale);
		await xaiSubscriptionAccessToken("u1", connectionId, "access-1");
		expect(oauth).toHaveBeenCalledTimes(1);
		const transport = api([200, {}]);
		const fetch = xaiSubscriptionFetch("u1", connectionId, transport);
		await send(fetch);
		expect(bearer(transport, 0)).toBe("Bearer access-2");
		// Rejecting the already replaced token reads the new one, no refresh.
		const again = await xaiSubscriptionAccessToken(
			"u1",
			connectionId,
			"access-1",
		);
		expect(again.token).toBe("access-2");
		expect(oauth).toHaveBeenCalledTimes(1);
	});
});

describe("refreshing an expiring sign-in", () => {
	it("asks for sign-in again only when xAI rejects the grant", async () => {
		await signIn(60);
		oauth.mockResolvedValueOnce(
			json(400, {
				error: "invalid_grant",
				error_description: "Refresh token has been revoked",
			}),
		);
		await expect(
			xaiSubscriptionAccessToken("u1", connectionId),
		).rejects.toMatchObject({ reason: "reconnect" });
		expect(await status()).toBe("reconnect");
		expect(transitions()).toEqual([
			expect.objectContaining({
				from: "ready",
				to: "reconnect",
				httpStatus: 400,
				body: expect.stringContaining("invalid_grant"),
			}),
		]);
	});

	it("keeps the sign-in through an edge block or an outage at the token endpoint", async () => {
		await signIn(60);
		for (const answer of [
			json(403, "<html>Sorry, you have been blocked</html>"),
			json(400, { error: "invalid_request" }),
			json(503, "unavailable"),
		]) {
			oauth.mockResolvedValueOnce(answer);
			await expect(
				xaiSubscriptionAccessToken("u1", connectionId),
			).rejects.toMatchObject({ reason: "unavailable" });
			expect(await status()).toBe("ready");
		}
		// The next refresh still has the original refresh token to spend.
		const next = await xaiSubscriptionAccessToken("u1", connectionId);
		expect(next.token).toBe("access-2");
		expect(String(oauth.mock.calls.at(-1)?.[1]?.body)).toContain(
			"refresh_token=refresh-1",
		);
	});

	it("keeps the old refresh token when xAI's answer omits a new one", async () => {
		await signIn(60);
		oauth.mockResolvedValueOnce(
			json(200, { access_token: "access-2", expires_in: 60 }),
		);
		await xaiSubscriptionAccessToken("u1", connectionId);
		await xaiSubscriptionAccessToken("u1", connectionId);
		expect(String(oauth.mock.calls[1]?.[1]?.body)).toContain(
			"refresh_token=refresh-1",
		);
	});
});
