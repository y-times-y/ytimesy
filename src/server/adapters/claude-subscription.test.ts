import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_TURN_REQUEST_CAP } from "#/domain/claude-code-proxy";
import { claudeCodeTurnRevision } from "#/domain/claude-code-route";
import {
	authorizeClaudeCodeProxy,
	checkClaudeSetupToken,
	claudePlanUsageForPicker,
	claudeSubscriptionStatus,
	disconnectClaudeSubscription,
	normalizedSetupToken,
	readClaudeCodeSession,
	recordClaudeCodeUpstream,
	saveClaudeCodeSession,
	saveClaudeSubscriptionToken,
} from "./claude-subscription";

const holder = vi.hoisted(() => {
	process.env.BETTER_AUTH_SECRET = "b".repeat(40);
	process.env.TOKEN_VAULT_KEY = "v".repeat(40);
	return { query: vi.fn() };
});
vi.mock("./database", () => ({ database: () => holder }));

const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789";
let db: PGlite;

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
	 create table agent_session(id uuid primary key,user_id text not null);
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,
	   connection_revision text,failover jsonb);
	 create table claude_subscription(user_id text primary key,sealed_token text not null,
	   status text not null,message text,limited_until timestamptz,
	   connected_at timestamptz not null default now(),updated_at timestamptz not null default now(),
	   plan_usage jsonb,plan_usage_at timestamptz);
	 create table claude_code_turn_request(turn_id uuid primary key,user_id text not null,
	   requests integer not null default 0,updated_at timestamptz not null default now());
	 create table claude_code_session(session_id uuid primary key,user_id text not null,
	   claude_session_id uuid not null,transcript_path text,cwd text not null,
	   updated_at timestamptz not null default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
	// Saving asks Anthropic once; the other tests see a token it accepts.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	await db.close();
});

async function turn(state = "running", revision = claudeCodeTurnRevision()) {
	const session = randomUUID();
	const id = randomUUID();
	await db.query("insert into agent_session(id,user_id) values($1,'u1')", [
		session,
	]);
	await db.query(
		"insert into api_turn(id,session_id,user_id,state,connection_revision) values($1,$2,'u1',$3,$4)",
		[id, session, state, revision],
	);
	return { userId: "u1", sessionId: session, turnId: id, expiresAt: 0 };
}

describe("Claude subscription", () => {
	it("accepts only setup tokens", () => {
		expect(normalizedSetupToken(` "${token}" `)).toBe(token);
		expect(
			normalizedSetupToken("sk-ant-api03-abcdefghijklmnopqrstuvwxyz"),
		).toBeNull();
		expect(normalizedSetupToken("hello")).toBeNull();
	});

	it("keeps the token sealed and bound to its user", async () => {
		await saveClaudeSubscriptionToken("u1", token);
		const stored = (
			await db.query<{ sealed_token: string }>(
				"select sealed_token from claude_subscription",
			)
		).rows[0]?.sealed_token;
		expect(stored).toMatch(/^v2\.k1\./);
		expect(stored).not.toContain(token);
		expect(await claudeSubscriptionStatus("u1")).toMatchObject({
			status: "connected",
		});
		// Moved to another user, the blob does not open.
		await db.query(
			"insert into claude_subscription(user_id,sealed_token,status) values('u2',$1,'connected')",
			[stored],
		);
		const other = await turn();
		await db.query("update api_turn set user_id='u2' where id=$1", [
			other.turnId,
		]);
		await expect(
			authorizeClaudeCodeProxy({ ...other, userId: "u2" }),
		).rejects.toThrow();
		await expect(saveClaudeSubscriptionToken("u1", "nope")).rejects.toThrow(
			/claude setup-token/,
		);
	});

	it("authorizes only a running Claude Code turn, counting its requests", async () => {
		await saveClaudeSubscriptionToken("u1", token);
		const running = await turn();
		expect(await authorizeClaudeCodeProxy(running)).toEqual({
			kind: "ok",
			token,
		});
		await authorizeClaudeCodeProxy(running);
		expect(
			(
				await db.query<{ requests: number }>(
					"select requests from claude_code_turn_request",
				)
			).rows[0]?.requests,
		).toBe(2);
		expect(await authorizeClaudeCodeProxy(await turn("completed"))).toEqual({
			kind: "refused",
			status: 401,
		});
		expect(
			await authorizeClaudeCodeProxy(await turn("running", "api-revision")),
		).toEqual({ kind: "refused", status: 401 });
		expect(
			await authorizeClaudeCodeProxy({ ...running, sessionId: randomUUID() }),
		).toEqual({ kind: "refused", status: 401 });
		await db.query("update claude_code_turn_request set requests=$1", [
			CLAUDE_CODE_TURN_REQUEST_CAP,
		]);
		expect(await authorizeClaudeCodeProxy(running)).toEqual({
			kind: "refused",
			status: 429,
		});
	});

	it("ends a turn's access once it failed over off Claude Code, and grants it to a turn that moved onto it", async () => {
		await saveClaudeSubscriptionToken("u1", token);
		const movedOff = await turn();
		await db.query("update api_turn set failover=$1 where id=$2", [
			JSON.stringify({
				route: { connectionRevision: "or-rev", connectionId: "x" },
			}),
			movedOff.turnId,
		]);
		expect(await authorizeClaudeCodeProxy(movedOff)).toEqual({
			kind: "refused",
			status: 401,
		});
		// Only a retry count in the column: still on Claude Code.
		const retried = await turn();
		await db.query("update api_turn set failover=$1 where id=$2", [
			JSON.stringify({ retry: { route: "claude-code|x", count: 1 } }),
			retried.turnId,
		]);
		expect((await authorizeClaudeCodeProxy(retried)).kind).toBe("ok");
		const movedOn = await turn("running", "api-revision");
		await db.query("update api_turn set failover=$1 where id=$2", [
			JSON.stringify({
				route: { connectionRevision: claudeCodeTurnRevision() },
			}),
			movedOn.turnId,
		]);
		expect((await authorizeClaudeCodeProxy(movedOn)).kind).toBe("ok");
	});

	it("marks a refused token and a spent plan, and forgets on disconnect", async () => {
		await saveClaudeSubscriptionToken("u1", token);
		const running = await turn();
		await recordClaudeCodeUpstream("u1", {
			kind: "usage-limit",
			resetsAt: Date.now() + 3_600_000,
		});
		expect(await claudeSubscriptionStatus("u1")).toMatchObject({
			status: "limited",
		});
		await recordClaudeCodeUpstream("u1", { kind: "refused", status: 401 });
		expect((await claudeSubscriptionStatus("u1")).status).toBe("refused");
		expect(await authorizeClaudeCodeProxy(running)).toEqual({
			kind: "refused",
			status: 403,
		});
		// A new token clears the refusal.
		await saveClaudeSubscriptionToken("u1", token);
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
		await disconnectClaudeSubscription("u1");
		expect(await claudeSubscriptionStatus("u1")).toEqual({
			status: "disconnected",
		});
		expect(await authorizeClaudeCodeProxy(running)).toEqual({
			kind: "refused",
			status: 403,
		});
	});

	it("treats a spent window that has reset as connected", async () => {
		await saveClaudeSubscriptionToken("u1", token);
		await recordClaudeCodeUpstream("u1", {
			kind: "usage-limit",
			resetsAt: Date.now() - 1_000,
		});
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
	});

	it("remembers the chat's Claude Code session", async () => {
		const { sessionId } = await turn();
		expect(await readClaudeCodeSession("u1", sessionId)).toBeNull();
		const record = {
			claudeSessionId: "33333333-3333-4333-8333-333333333333",
			transcriptPath: "abc/claude-code-x.enc",
			cwd: "/home/ubuntu/repo",
		};
		await saveClaudeCodeSession("u1", sessionId, record);
		expect(await readClaudeCodeSession("u1", sessionId)).toEqual(record);
		expect(await readClaudeCodeSession("u2", sessionId)).toBeNull();
		await expect(
			saveClaudeCodeSession("u1", sessionId, {
				...record,
				claudeSessionId: "../x",
			}),
		).rejects.toThrow();
	});
});

it("accepts a setup token the terminal wrapped across lines", () => {
	const token = `sk-ant-oat01-${"a".repeat(40)}_${"B".repeat(40)}-AA`;
	const wrapped = `${token.slice(0, 50)}\n  ${token.slice(50, 80)}\r\n${token.slice(80)} \n`;
	expect(normalizedSetupToken(wrapped)).toBe(token);
	expect(normalizedSetupToken(`"${token}"`)).toBe(token);
	expect(normalizedSetupToken("not a token")).toBeNull();
});

describe("checks the token with Anthropic before saving", () => {
	const answering = (status: number) =>
		vi.fn<typeof fetch>(async () => new Response("{}", { status }));

	it("sends one token-counting call with the OAuth headers", async () => {
		const fetch = answering(200);
		expect(await checkClaudeSetupToken(token, { fetch })).toBe("accepted");
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://api.anthropic.com/v1/messages/count_tokens");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "claude-haiku-5-5",
			messages: [{ role: "user", content: "hi" }],
		});
	});

	it("rejects an authentication failure and stores nothing", async () => {
		for (const status of [401]) {
			await expect(
				saveClaudeSubscriptionToken("u1", token, {
					fetch: answering(status),
				}),
			).rejects.toThrow(
				"Anthropic refused this token. Run claude setup-token again.",
			);
		}
		expect(await claudeSubscriptionStatus("u1")).toEqual({
			status: "disconnected",
		});
	});

	it("retains a submitted token when an endpoint returns a permission denial", async () => {
		await saveClaudeSubscriptionToken("u1", token, { fetch: answering(403) });
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
	});
	it("saves a token Anthropic accepts as connected", async () => {
		await saveClaudeSubscriptionToken("u1", token, {
			fetch: answering(200),
		});
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
	});

	it("saves anyway when Anthropic is busy, without logging the token", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await saveClaudeSubscriptionToken("u1", token, {
			fetch: answering(429),
		});
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
		expect(warn).toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
	});

	it("saves anyway when Anthropic does not answer in time", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const hanging = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
		);
		await saveClaudeSubscriptionToken("u1", token, {
			fetch: hanging,
			timeoutMs: 20,
		});
		expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
		expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
	});
});

describe("reads the Claude plan's usage for the picker", () => {
	const reset = Math.floor(Date.now() / 1000) + 3600;
	const usageHeaders = (fiveHour: string, status = "allowed") => ({
		"anthropic-ratelimit-unified-status": status,
		"anthropic-ratelimit-unified-reset": String(reset),
		"anthropic-ratelimit-unified-5h-utilization": fiveHour,
		"anthropic-ratelimit-unified-5h-reset": String(reset),
		"anthropic-ratelimit-unified-7d-utilization": "0.2",
		"anthropic-ratelimit-unified-7d-reset": String(reset + 86_400),
	});
	const answering = (status: number, headers: Record<string, string> = {}) =>
		vi.fn<typeof fetch>(async () => new Response("{}", { status, headers }));
	const percents = (
		usage: Awaited<ReturnType<typeof claudePlanUsageForPicker>>,
	) => usage?.windows.map((window) => window.usedPercent);

	beforeEach(async () => {
		await saveClaudeSubscriptionToken("u1", token, { fetch: answering(200) });
	});

	it("sends one 1-token Haiku request as Claude Code and saves the reading", async () => {
		const fetch = answering(200, usageHeaders("0.4"));
		const usage = await claudePlanUsageForPicker("u1", { fetch });
		expect(percents(usage)).toEqual([40, 20]);
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0] ?? [];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${token}`);
		expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
		const body = JSON.parse(String(init?.body));
		expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 1 });
		expect(body.system[0].text).toBe(
			"You are Claude Code, Anthropic's official CLI for Claude.",
		);
		const stored = (
			await db.query<{ plan_usage: { windows: unknown[] } }>(
				"select plan_usage from claude_subscription",
			)
		).rows[0];
		expect(stored?.plan_usage.windows).toHaveLength(2);
	});

	it("sends at most one request per five minutes, however often the picker opens", async () => {
		const fetch = answering(200, usageHeaders("0.4"));
		await claudePlanUsageForPicker("u1", { fetch });
		const again = await claudePlanUsageForPicker("u1", {
			fetch: answering(200, usageHeaders("0.9")),
		});
		expect(percents(again)).toEqual([40, 20]);
		expect(fetch).toHaveBeenCalledTimes(1);
		// Past five minutes it reads again.
		await db.query(
			"update claude_subscription set plan_usage_at=now()-interval '6 minutes'",
		);
		const later = answering(200, usageHeaders("0.9"));
		expect(
			percents(await claudePlanUsageForPicker("u1", { fetch: later })),
		).toEqual([90, 20]);
		expect(later).toHaveBeenCalledTimes(1);
	});

	it("shares one request between opens that arrive together", async () => {
		let answer: (response: Response) => void = () => {};
		const pending = vi.fn<typeof fetch>(
			() => new Promise((resolve) => (answer = resolve)),
		);
		const first = claudePlanUsageForPicker("u1", { fetch: pending });
		const second = claudePlanUsageForPicker("u1", { fetch: pending });
		expect(second).toBe(first);
		await vi.waitFor(() => expect(pending).toHaveBeenCalledTimes(1));
		answer(new Response("{}", { status: 200, headers: usageHeaders("0.5") }));
		expect(percents(await first)).toEqual([50, 20]);
		expect(percents(await second)).toEqual([50, 20]);
		expect(pending).toHaveBeenCalledTimes(1);
	});

	it("keeps the last reading on failure and does not retry within five minutes", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await claudePlanUsageForPicker("u1", {
			fetch: answering(200, usageHeaders("0.3")),
		});
		await db.query(
			"update claude_subscription set plan_usage_at=now()-interval '6 minutes'",
		);
		const failing = vi.fn<typeof fetch>(async () => {
			throw new TypeError("network");
		});
		expect(
			percents(await claudePlanUsageForPicker("u1", { fetch: failing })),
		).toEqual([30, 20]);
		const next = answering(200, usageHeaders("0.9"));
		expect(
			percents(await claudePlanUsageForPicker("u1", { fetch: next })),
		).toEqual([30, 20]);
		expect(next).not.toHaveBeenCalled();
		expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
	});

	it("gives up after a short timeout", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const hanging = vi.fn<typeof fetch>(
			(_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () =>
						reject(init.signal?.reason),
					),
				),
		);
		expect(
			await claudePlanUsageForPicker("u1", { fetch: hanging, timeoutMs: 10 }),
		).toBeNull();
	});

	it("does not disconnect a saved token when the usage probe is denied", async () => {
		for (const status of [401, 403]) {
			await db.query(
				"update claude_subscription set status='connected',plan_usage_at=null",
			);
			expect(
				await claudePlanUsageForPicker("u1", { fetch: answering(status) }),
			).toBeNull();
			expect((await claudeSubscriptionStatus("u1")).status).toBe("connected");
		}
	});

	it("records a spent plan from a rejected reading", async () => {
		const usage = await claudePlanUsageForPicker("u1", {
			fetch: answering(429, usageHeaders("1", "rejected")),
		});
		expect(usage?.status).toBe("rejected");
		expect((await claudeSubscriptionStatus("u1")).status).toBe("limited");
	});

	it("sends nothing while Claude is not connected", async () => {
		await disconnectClaudeSubscription("u1");
		const fetch = answering(200, usageHeaders("0.4"));
		expect(await claudePlanUsageForPicker("u1", { fetch })).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});
});
