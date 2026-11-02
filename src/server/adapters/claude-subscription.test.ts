import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_TURN_REQUEST_CAP } from "#/domain/claude-code-proxy";
import { claudeCodeTurnRevision } from "#/domain/claude-code-route";
import {
	authorizeClaudeCodeProxy,
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
	   connected_at timestamptz not null default now(),updated_at timestamptz not null default now());
	 create table claude_code_turn_request(turn_id uuid primary key,user_id text not null,
	   requests integer not null default 0,updated_at timestamptz not null default now());
	 create table claude_code_session(session_id uuid primary key,user_id text not null,
	   claude_session_id uuid not null,transcript_path text,cwd text not null,
	   updated_at timestamptz not null default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
});
afterEach(() => db.close());

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
