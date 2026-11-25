import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seal, unseal } from "../auth/token-vault";
import {
	addClaudeAccount,
	addCodexAccount,
	extraAccountSeal,
	listSubscriptionAccounts,
	MAX_ACCOUNTS_PER_PROVIDER,
	markAccountLimited,
	openExtraAccount,
	pinSessionAccount,
	recordAccountUsed,
	removeSubscriptionAccount,
	renameSubscriptionAccount,
	reorderSubscriptionAccounts,
	sessionAccountPin,
} from "./subscription-accounts";

const holder = vi.hoisted(() => {
	process.env.BETTER_AUTH_SECRET = "b".repeat(40);
	process.env.TOKEN_VAULT_KEY = "v".repeat(40);
	return { query: vi.fn() };
});
vi.mock("./database", () => ({ database: () => holder }));

const token = (n: number) => `sk-ant-oat01-${String(n).repeat(30)}`;
const user = "alice";
let db: PGlite;

beforeEach(async () => {
	db = new PGlite();
	// The tables the migration alters, as earlier migrations left them.
	await db.exec(`
	 create role anon; create role authenticated;
	 create table auth_user(id text primary key);
	 insert into auth_user values('alice'),('bob');
	 create table agent_session(id uuid primary key,user_id text not null);
	 create table agent_account(user_id text not null,provider text not null,
	   status text not null,encrypted_codex_auth text,plan_type text,email text,message text,
	   updated_at timestamptz not null default now(),primary key(user_id,provider));
	 create table claude_subscription(user_id text primary key,sealed_token text not null,
	   status text not null,message text,limited_until timestamptz,
	   connected_at timestamptz not null default now(),updated_at timestamptz not null default now());`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261125170000_subscription_account.sql",
			"utf8",
		),
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return {
			...result,
			rowCount: result.rows.length || (result.affectedRows ?? 0),
		};
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 200 })),
	);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await db.close();
});

async function primaryClaude(n = 1) {
	await db.query(
		"insert into claude_subscription(user_id,sealed_token,status) values($1,$2,'connected')",
		[
			user,
			await seal(token(n), { purpose: "claude-subscription", userId: user }),
		],
	);
}

describe("back-compat: a single existing connection", () => {
	it("is listed as the primary account with its old state and no migration of data", async () => {
		await primaryClaude();
		const accounts = await listSubscriptionAccounts(user);
		expect(accounts).toHaveLength(1);
		expect(accounts[0]).toMatchObject({
			id: "primary",
			provider: "claude",
			primary: true,
			state: "valid",
			label: "Main account",
		});
		const row = (await db.query("select sealed_token from claude_subscription"))
			.rows[0] as { sealed_token: string };
		// Still opens under the original binding: nothing was re-sealed.
		expect(
			await unseal(row.sealed_token, {
				purpose: "claude-subscription",
				userId: user,
			}),
		).toBe(token(1));
	});
	it("lists a Codex primary only when its login is present", async () => {
		await db.query(
			"insert into agent_account(user_id,provider,status,email,plan_type) values($1,'codex','connected','a@b.co','plus')",
			[user],
		);
		expect(await listSubscriptionAccounts(user)).toHaveLength(0);
		await db.query("update agent_account set encrypted_codex_auth='x'");
		const [codex] = await listSubscriptionAccounts(user);
		expect(codex).toMatchObject({
			provider: "codex",
			email: "a•••@b.co",
			planType: "plus",
		});
	});
	it("lists nothing for a user with no connection", async () => {
		expect(await listSubscriptionAccounts("bob")).toEqual([]);
	});
});

describe("adding accounts", () => {
	it("adds a second Claude account, sealed per account, never returning the token", async () => {
		await primaryClaude(1);
		const id = await addClaudeAccount(user, { token: token(2), label: "Work" });
		const accounts = await listSubscriptionAccounts(user);
		expect(accounts.map((a) => a.label)).toEqual(["Main account", "Work"]);
		expect(JSON.stringify(accounts)).not.toContain(token(2));
		const row = (await db.query("select sealed_auth from subscription_account"))
			.rows[0] as { sealed_auth: string };
		expect(await openExtraAccount(user, id, row.sealed_auth)).toBe(token(2));
		// Bound to the user and the account: another user cannot open it.
		await expect(
			openExtraAccount("bob", id, row.sealed_auth),
		).rejects.toThrow();
		await expect(
			openExtraAccount(user, randomUUID(), row.sealed_auth),
		).rejects.toThrow();
	});
	it("refuses the same Claude token twice, including the main connection's", async () => {
		await primaryClaude(1);
		await expect(
			addClaudeAccount(user, { token: token(1), label: "Dup" }),
		).rejects.toThrow(/already connected/);
		await addClaudeAccount(user, { token: token(2), label: "B" });
		await expect(
			addClaudeAccount(user, { token: token(2), label: "B again" }),
		).rejects.toThrow(/already connected/);
	});
	it("refuses a token Anthropic rejects and a malformed one", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 401 })),
		);
		await expect(
			addClaudeAccount(user, { token: token(3), label: "X" }),
		).rejects.toThrow(/refused/);
		await expect(
			addClaudeAccount(user, { token: "nope", label: "X" }),
		).rejects.toThrow(/not a Claude Code token/);
		expect(await listSubscriptionAccounts(user)).toEqual([]);
	});
	it("caps accounts per provider", async () => {
		for (let n = 1; n <= MAX_ACCOUNTS_PER_PROVIDER; n++)
			await addClaudeAccount(user, { token: token(n), label: `A${n}` });
		await expect(
			addClaudeAccount(user, { token: token(9), label: "Six" }),
		).rejects.toThrow(/up to 5/);
	});
	it("concurrent adds of one account store it once", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				addClaudeAccount(user, { token: token(4), label: "Race" }),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect((await listSubscriptionAccounts(user)).length).toBe(1);
	});
	it("adds a Codex account once per ChatGPT account id", async () => {
		const add = (accountId: string) =>
			addCodexAccount(
				{ query: (sql, values) => holder.query(sql, values as unknown[]) },
				user,
				{
					accountId,
					label: "Team",
					email: "t@x.io",
					planType: "pro",
					sealedAuth: (id) => extraAccountSeal(user, id, "{}"),
				},
			);
		expect(await add("acct-1")).toBe("added");
		expect(await add("acct-1")).toBe("duplicate");
		expect(await add("acct-2")).toBe("added");
		expect((await listSubscriptionAccounts(user)).map((a) => a.email)).toEqual([
			"t•••@x.io",
			"t•••@x.io",
		]);
	});
});

describe("rename, order, remove, promote", () => {
	it("renames the primary and an extra", async () => {
		await primaryClaude(1);
		const id = await addClaudeAccount(user, { token: token(2), label: "Old" });
		await renameSubscriptionAccount(user, "claude", "primary", "Personal");
		await renameSubscriptionAccount(user, "claude", id, "  Work  plan ");
		expect((await listSubscriptionAccounts(user)).map((a) => a.label)).toEqual([
			"Personal",
			"Work plan",
		]);
		await expect(
			renameSubscriptionAccount(user, "claude", id, ""),
		).rejects.toThrow();
		await expect(
			renameSubscriptionAccount("bob", "claude", id, "Mine"),
		).rejects.toThrow(/no longer exists/);
	});
	it("reorders by priority, primary included", async () => {
		await primaryClaude(1);
		const b = await addClaudeAccount(user, { token: token(2), label: "B" });
		const c = await addClaudeAccount(user, { token: token(3), label: "C" });
		await reorderSubscriptionAccounts(user, "claude", [c, "primary", b]);
		expect((await listSubscriptionAccounts(user)).map((a) => a.label)).toEqual([
			"C",
			"Main account",
			"B",
		]);
	});
	it("disconnecting an extra leaves the rest alone", async () => {
		await primaryClaude(1);
		const id = await addClaudeAccount(user, { token: token(2), label: "B" });
		await removeSubscriptionAccount(user, "claude", id);
		expect((await listSubscriptionAccounts(user)).map((a) => a.id)).toEqual([
			"primary",
		]);
	});
	it("disconnecting the main account promotes the next one under the main binding", async () => {
		await primaryClaude(1);
		await addClaudeAccount(user, { token: token(2), label: "Work" });
		await removeSubscriptionAccount(user, "claude", "primary");
		const [only, ...rest] = await listSubscriptionAccounts(user);
		expect(rest).toEqual([]);
		expect(only).toMatchObject({ id: "primary", label: "Work" });
		const row = (await db.query("select sealed_token from claude_subscription"))
			.rows[0] as { sealed_token: string };
		expect(
			await unseal(row.sealed_token, {
				purpose: "claude-subscription",
				userId: user,
			}),
		).toBe(token(2));
		expect(
			(await db.query("select 1 from subscription_account")).rows,
		).toHaveLength(0);
	});
	it("disconnecting the only account removes it", async () => {
		await primaryClaude(1);
		await removeSubscriptionAccount(user, "claude", "primary");
		expect(await listSubscriptionAccounts(user)).toEqual([]);
	});
});

describe("limits and use", () => {
	it("marks an account limited until the reported reset, then shows it valid again", async () => {
		await primaryClaude(1);
		const id = await addClaudeAccount(user, { token: token(2), label: "B" });
		const now = Date.now();
		await markAccountLimited(user, "claude", id, {
			reportedResetAt: now + 3_600_000,
			now,
		});
		const limited = (await listSubscriptionAccounts(user, now)).find(
			(a) => a.id === id,
		);
		expect(limited).toMatchObject({ state: "limited" });
		expect(limited?.limitedUntil).toBeCloseTo(now + 3_600_000, -4);
		const later = (await listSubscriptionAccounts(user, now + 3_700_000)).find(
			(a) => a.id === id,
		);
		expect(later).toMatchObject({ state: "valid", limitedUntil: null });
	});
	it("limits a Codex primary through limited_until without a new status", async () => {
		await db.query(
			"insert into agent_account(user_id,provider,status,encrypted_codex_auth) values($1,'codex','connected','x')",
			[user],
		);
		const now = Date.now();
		await markAccountLimited(user, "codex", "primary", {
			reportedResetAt: now + 60_000,
			now,
		});
		expect((await listSubscriptionAccounts(user, now))[0]?.state).toBe(
			"limited",
		);
		expect(
			(await listSubscriptionAccounts(user, now + 120_000))[0]?.state,
		).toBe("valid");
	});
	it("records use for the round robin", async () => {
		await primaryClaude(1);
		await recordAccountUsed(user, "claude", "primary");
		expect(
			(await listSubscriptionAccounts(user))[0]?.lastUsedAt,
		).not.toBeNull();
	});
	it("bookkeeping never throws", async () => {
		holder.query.mockRejectedValueOnce(new Error("db down"));
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		await expect(
			markAccountLimited(user, "claude", "primary", { reportedResetAt: null }),
		).resolves.toBeGreaterThan(0);
	});
});

describe("pinning a chat", () => {
	it("pins, reads and clears a chat's account", async () => {
		await primaryClaude(1);
		const id = await addClaudeAccount(user, { token: token(2), label: "B" });
		const session = randomUUID();
		await db.query("insert into agent_session(id,user_id) values($1,$2)", [
			session,
			user,
		]);
		expect(await sessionAccountPin(user, session)).toBeNull();
		await pinSessionAccount(user, session, id);
		expect(await sessionAccountPin(user, session)).toBe(id);
		await pinSessionAccount(user, session, "primary");
		expect(await sessionAccountPin(user, session)).toBe("primary");
		await pinSessionAccount(user, session, null);
		expect(await sessionAccountPin(user, session)).toBeNull();
	});
	it("refuses another user's chat or account", async () => {
		const session = randomUUID();
		await db.query("insert into agent_session(id,user_id) values($1,'bob')", [
			session,
		]);
		await expect(pinSessionAccount(user, session, null)).rejects.toThrow(
			/Chat not found/,
		);
		await expect(
			pinSessionAccount(user, session, randomUUID()),
		).rejects.toThrow(/no longer exists/);
	});
});
