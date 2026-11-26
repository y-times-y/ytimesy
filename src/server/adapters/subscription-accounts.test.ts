import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seal, unseal } from "../auth/token-vault";
import {
	activateSubscriptionAccount,
	addClaudeAccount,
	addCodexAccount,
	addGrokAccount,
	extraAccountSeal,
	listSubscriptionAccounts,
	MAX_ACCOUNTS_PER_PROVIDER,
	markAccountLimited,
	openExtraAccount,
	pinSessionAccount,
	prepareTurnAccount,
	recordAccountUsed,
	removeSubscriptionAccount,
	renameSubscriptionAccount,
	reorderSubscriptionAccounts,
	rotateAfterLimit,
	sessionAccountPin,
} from "./subscription-accounts";

const holder = vi.hoisted(() => {
	process.env.BETTER_AUTH_SECRET = "b".repeat(40);
	process.env.TOKEN_VAULT_KEY = "v".repeat(40);
	// One transaction at a time, like the row locks the real code takes.
	const lockImpl = {
		tail: Promise.resolve() as Promise<void>,
		acquire(): Promise<() => void> {
			const previous = this.tail;
			let release: () => void = () => undefined;
			this.tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			return previous.then(() => release);
		},
	};
	return { query: vi.fn(), connect: vi.fn(), lock: lockImpl };
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
	 create table api_turn(id uuid primary key,user_id text,state text);
	 create table model_connection(id uuid primary key,user_id text not null,provider text not null,
	   label text not null,kind text not null default 'key',status text not null default 'ready',
	   sealed_credential text,models jsonb not null default '[]',revision text not null default 'r',
	   plan_usage jsonb,plan_usage_at timestamptz,updated_at timestamptz not null default now());
	 create table xai_device_login(user_id text primary key,sealed_login text);
	 create table claude_subscription(user_id text primary key,sealed_token text not null,
	   status text not null,message text,limited_until timestamptz,
	   connected_at timestamptz not null default now(),updated_at timestamptz not null default now(),
	   plan_usage jsonb,plan_usage_at timestamptz);`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261125170000_subscription_account.sql",
			"utf8",
		),
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261126150000_subscription_account_grok.sql",
			"utf8",
		),
	);
	holder.connect.mockImplementation(async () => {
		const unlock = await holder.lock.acquire();
		let held = true;
		const release = () => {
			if (held) unlock();
			held = false;
		};
		return {
			query: async (sql: string, values: unknown[]) => {
				const result = await db.query(sql, values);
				if (/^(commit|rollback)/i.test(sql.trim())) release();
				return {
					...result,
					rowCount: result.rows.length || (result.affectedRows ?? 0),
				};
			},
			release,
		};
	});
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
			provider: "claude",
			active: true,
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
		expect((await listSubscriptionAccounts(user)).map((a) => a.label)).toEqual([
			"Main account",
		]);
	});
	it("disconnecting the main account promotes the next one under the main binding", async () => {
		await primaryClaude(1);
		await addClaudeAccount(user, { token: token(2), label: "Work" });
		await removeSubscriptionAccount(user, "claude", "primary");
		const [only, ...rest] = await listSubscriptionAccounts(user);
		expect(rest).toEqual([]);
		expect(only).toMatchObject({ active: true, label: "Work" });
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

const HOUR = 3_600_000;
async function slotToken() {
	const row = (await db.query("select sealed_token from claude_subscription"))
		.rows[0] as { sealed_token: string };
	return unseal(row.sealed_token, {
		purpose: "claude-subscription",
		userId: user,
	});
}
/** Two Claude accounts, the first in the slot; settled long enough that a limit counts. */
async function twoClaude() {
	await primaryClaude(1);
	const second = await addClaudeAccount(user, {
		token: token(2),
		label: "Second",
	});
	await db.query(
		"update claude_subscription set activated_at=now()-interval '1 hour'",
	);
	const [first] = (await listSubscriptionAccounts(user)).filter(
		(a) => a.active,
	);
	return { firstId: first?.id as string, secondId: second };
}
const chatFor = async () => {
	const id = randomUUID();
	await db.query("insert into agent_session(id,user_id) values($1,$2)", [
		id,
		user,
	]);
	return id;
};

describe("switching the account in use", () => {
	it("moves the whole account into the slot and the old one out, keeping ids and names", async () => {
		const { firstId, secondId } = await twoClaude();
		expect(await activateSubscriptionAccount(user, "claude", secondId)).toBe(
			"switched",
		);
		expect(await slotToken()).toBe(token(2));
		const accounts = await listSubscriptionAccounts(user);
		expect(accounts.find((a) => a.active)).toMatchObject({
			id: secondId,
			label: "Second",
		});
		expect(accounts.find((a) => !a.active)).toMatchObject({
			id: firstId,
			label: "Main account",
		});
		const waiting = (
			await db.query("select sealed_auth from subscription_account")
		).rows[0] as { sealed_auth: string };
		expect(await openExtraAccount(user, firstId, waiting.sealed_auth)).toBe(
			token(1),
		);
		expect(await activateSubscriptionAccount(user, "claude", secondId)).toBe(
			"already",
		);
		expect(
			await activateSubscriptionAccount(user, "claude", randomUUID()),
		).toBe("missing");
	});
	it("switches a Codex slot too, re-sealing under the codex-auth binding", async () => {
		const auth = (n: number) =>
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					access_token: `a${n}`,
					refresh_token: `r${n}`,
					account_id: `acct-${n}`,
				},
			});
		await db.query(
			"insert into agent_account(user_id,provider,status,encrypted_codex_auth,email) values($1,'codex','connected',$2,'one@x.io')",
			[user, await seal(auth(1), { purpose: "codex-auth", userId: user })],
		);
		const client = {
			query: (sql: string, values?: unknown[]) =>
				holder.query(sql, values as unknown[]),
		};
		await addCodexAccount(client, user, {
			accountId: "acct-2",
			label: "Two",
			email: "two@x.io",
			planType: "plus",
			sealedAuth: (id) => extraAccountSeal(user, id, auth(2)),
		});
		const waiting = (
			await db.query("select id::text from subscription_account")
		).rows[0] as { id: string };
		expect(await activateSubscriptionAccount(user, "codex", waiting.id)).toBe(
			"switched",
		);
		const slot = (
			await db.query(
				"select encrypted_codex_auth,email,label from agent_account",
			)
		).rows[0] as { encrypted_codex_auth: string; email: string; label: string };
		expect(
			JSON.parse(
				await unseal(slot.encrypted_codex_auth, {
					purpose: "codex-auth",
					userId: user,
				}),
			).tokens.account_id,
		).toBe("acct-2");
		expect(slot).toMatchObject({ email: "two@x.io", label: "Two" });
		const out = (await db.query("select external_id from subscription_account"))
			.rows[0] as { external_id: string };
		expect(out.external_id).toBe("acct-1");
	});
	it("concurrent switches leave exactly the two accounts, one in the slot, none lost", async () => {
		const { firstId, secondId } = await twoClaude();
		await Promise.all([
			activateSubscriptionAccount(user, "claude", secondId),
			activateSubscriptionAccount(user, "claude", firstId),
			activateSubscriptionAccount(user, "claude", secondId),
		]);
		const accounts = await listSubscriptionAccounts(user);
		expect(accounts.map((a) => a.id).sort()).toEqual(
			[firstId, secondId].sort(),
		);
		expect(accounts.filter((a) => a.active)).toHaveLength(1);
		const active = accounts.find((a) => a.active);
		expect(await slotToken()).toBe(
			active?.id === firstId ? token(1) : token(2),
		);
	});
});

describe("choosing the account for a turn", () => {
	it("does nothing for a user with one account (existing behaviour)", async () => {
		await primaryClaude(1);
		expect(
			await prepareTurnAccount(user, "claude", {
				sessionId: await chatFor(),
				turnId: null,
			}),
		).toBeNull();
		expect(await slotToken()).toBe(token(1));
	});
	it("a pinned chat gets its account, Auto keeps the one in use", async () => {
		const { firstId, secondId } = await twoClaude();
		const chat = await chatFor();
		const auto = await prepareTurnAccount(user, "claude", {
			sessionId: chat,
			turnId: null,
		});
		expect(auto).toMatchObject({ accountId: firstId, switched: false });
		await pinSessionAccount(user, chat, secondId);
		const pinned = await prepareTurnAccount(user, "claude", {
			sessionId: chat,
			turnId: null,
		});
		expect(pinned).toMatchObject({ accountId: secondId, switched: true });
		expect(await slotToken()).toBe(token(2));
	});
	it("does not change the account under a turn that is running", async () => {
		const { firstId, secondId } = await twoClaude();
		const chat = await chatFor();
		await pinSessionAccount(user, chat, secondId);
		await db.query(
			"insert into api_turn(id,user_id,state) values($1,$2,'running')",
			[randomUUID(), user],
		);
		const result = await prepareTurnAccount(user, "claude", {
			sessionId: chat,
			turnId: randomUUID(),
		});
		expect(result).toMatchObject({ accountId: firstId, switched: false });
		expect(await slotToken()).toBe(token(1));
	});
	it("a pin on a limited account falls back to the account that works", async () => {
		const { firstId, secondId } = await twoClaude();
		const chat = await chatFor();
		await pinSessionAccount(user, chat, secondId);
		await markAccountLimited(user, "claude", secondId, {
			reportedResetAt: Date.now() + HOUR,
		});
		expect(
			await prepareTurnAccount(user, "claude", {
				sessionId: chat,
				turnId: null,
			}),
		).toMatchObject({ accountId: firstId });
	});
	it("Auto uses a higher-priority account again once it has reset", async () => {
		const { firstId, secondId } = await twoClaude();
		const chat = await chatFor();
		await reorderSubscriptionAccounts(user, "claude", [secondId, firstId]);
		const now = Date.now();
		await markAccountLimited(user, "claude", secondId, {
			reportedResetAt: now + HOUR,
			now,
		});
		expect(
			(
				await prepareTurnAccount(user, "claude", {
					sessionId: chat,
					turnId: null,
					now,
				})
			)?.accountId,
		).toBe(firstId);
		const later = now + 2 * HOUR;
		expect(
			(
				await prepareTurnAccount(user, "claude", {
					sessionId: chat,
					turnId: null,
					now: later,
				})
			)?.accountId,
		).toBe(secondId);
	});
});

describe("failover when the account in use hits a plan limit", () => {
	it("rests it until the reported reset and moves to the next account of the provider", async () => {
		const { firstId, secondId } = await twoClaude();
		const now = Date.now();
		const result = await rotateAfterLimit(user, "claude", {
			reportedResetAt: now + 2 * HOUR,
			now,
		});
		expect(result).toMatchObject({
			kind: "rotated",
			to: { accountId: secondId },
		});
		expect(await slotToken()).toBe(token(2));
		const limited = (await listSubscriptionAccounts(user, now)).find(
			(a) => a.id === firstId,
		);
		expect(limited?.state).toBe("limited");
		expect(limited?.limitedUntil).toBeCloseTo(now + 2 * HOUR, -4);
		// "limited, resets at …" clears itself once the time passes.
		expect(
			(await listSubscriptionAccounts(user, now + 3 * HOUR)).find(
				(a) => a.id === firstId,
			)?.state,
		).toBe("valid");
	});
	it("reports none when every other account is limited, so the caller falls to another provider", async () => {
		const { secondId } = await twoClaude();
		const now = Date.now();
		await markAccountLimited(user, "claude", secondId, {
			reportedResetAt: now + HOUR,
			now,
		});
		expect(
			(
				await rotateAfterLimit(user, "claude", {
					reportedResetAt: now + HOUR,
					now,
				})
			).kind,
		).toBe("none");
		expect(await slotToken()).toBe(token(1));
	});
	it("a user with one account gets none (the old provider failover runs)", async () => {
		await primaryClaude(1);
		expect(
			(await rotateAfterLimit(user, "claude", { reportedResetAt: null })).kind,
		).toBe("none");
		expect((await listSubscriptionAccounts(user))[0]?.state).toBe("valid");
	});
	it("a limit right after a switch is stale and blames nobody", async () => {
		const { secondId } = await twoClaude();
		await activateSubscriptionAccount(user, "claude", secondId);
		const result = await rotateAfterLimit(user, "claude", {
			reportedResetAt: Date.now() + HOUR,
		});
		expect(result.kind).toBe("stale");
		expect(
			(await listSubscriptionAccounts(user)).every((a) => a.state === "valid"),
		).toBe(true);
	});
	it("walks through three accounts, then runs out", async () => {
		await primaryClaude(1);
		await addClaudeAccount(user, { token: token(2), label: "B" });
		await addClaudeAccount(user, { token: token(3), label: "C" });
		const now = Date.now();
		const settle = () =>
			db.query(
				"update claude_subscription set activated_at=now()-interval '1 hour'",
			);
		const seen: string[] = [];
		for (let i = 0; i < 3; i++) {
			await settle();
			const result = await rotateAfterLimit(user, "claude", {
				reportedResetAt: now + HOUR,
				now,
			});
			seen.push(result.kind);
		}
		expect(seen).toEqual(["rotated", "rotated", "none"]);
	});
});

describe("the provider's usage windows", () => {
	it("lists each account's last reading and it moves with the account", async () => {
		const { firstId, secondId } = await twoClaude();
		const now = Date.now();
		await db.query("update claude_subscription set plan_usage=$1::jsonb", [
			JSON.stringify({
				status: "allowed",
				resetsAt: now + HOUR,
				readAt: now,
				windows: [{ id: "5h", usedPercent: 62, resetsAt: now + HOUR }],
			}),
		]);
		const slot = (await listSubscriptionAccounts(user, now)).find(
			(a) => a.id === firstId,
		);
		expect(slot?.windows.map((w) => [w.label, w.usedPercent])).toEqual([
			["5h", 62],
		]);
		await activateSubscriptionAccount(user, "claude", secondId);
		const accounts = await listSubscriptionAccounts(user, now);
		expect(accounts.find((a) => a.id === firstId)?.windows).toHaveLength(1);
		expect(accounts.find((a) => a.id === secondId)?.windows).toEqual([]);
	});
	it("a full window ahead of its reset limits the account before any turn finds out", async () => {
		const { secondId } = await twoClaude();
		const now = Date.now();
		await db.query(
			"update subscription_account set plan_usage=$1::jsonb where id=$2::uuid",
			[
				JSON.stringify({
					status: "rejected",
					resetsAt: now + HOUR,
					readAt: now,
					windows: [{ id: "5h", usedPercent: 100, resetsAt: now + HOUR }],
				}),
				secondId,
			],
		);
		const second = (await listSubscriptionAccounts(user, now)).find(
			(a) => a.id === secondId,
		);
		expect(second?.state).toBe("limited");
		expect(second?.limitedUntil).toBe(now + HOUR);
		// It clears once the window has reset.
		expect(
			(await listSubscriptionAccounts(user, now + 2 * HOUR)).find(
				(a) => a.id === secondId,
			)?.state,
		).toBe("valid");
	});
});

const xaiTokens = (n: number, connectionId: string) =>
	JSON.stringify({
		connectionId,
		userId: user,
		accessToken: `access-${n}`,
		refreshToken: `refresh-${n}`,
		expiresAt: Date.now() + 6 * HOUR,
	});
const sealXai = (json: string) =>
	seal(json, { purpose: "xai-subscription", userId: user });
/** A Grok main connection (the slot) and one waiting account. */
async function twoGrok() {
	const rowId = randomUUID();
	await db.query(
		`insert into model_connection(id,user_id,provider,label,kind,status,sealed_credential,account_label)
		 values($1,$2,'compatible','Grok plan','xai-subscription','ready',$3,'SuperGrok')`,
		[rowId, user, await sealXai(xaiTokens(1, rowId))],
	);
	await db.query(
		"update model_connection set activated_at=now()-interval '1 hour'",
	);
	const waitingId = randomUUID();
	await db.query(
		`insert into subscription_account(id,user_id,provider,label,external_id,sealed_auth,priority)
		 values($1,$2,'grok','Heavy',$4,$3,1)`,
		[
			waitingId,
			user,
			await extraAccountSeal(user, waitingId, xaiTokens(2, rowId)),
			waitingId,
		],
	);
	const slot = (
		await db.query("select account_id::text as id from model_connection")
	).rows[0] as { id: string };
	return { rowId, slotId: slot.id, waitingId };
}
const slotTokens = async () => {
	const row = (await db.query("select sealed_credential from model_connection"))
		.rows[0] as { sealed_credential: string };
	return JSON.parse(
		await unseal(row.sealed_credential, {
			purpose: "xai-subscription",
			userId: user,
		}),
	);
};
const grokOnly = async () =>
	(await listSubscriptionAccounts(user)).filter((a) => a.provider === "grok");

describe("Grok accounts", () => {
	it("lists the main connection and the waiting account, the first in use", async () => {
		const { slotId, waitingId } = await twoGrok();
		const grok = await grokOnly();
		expect(grok.map((a) => [a.label, a.active])).toEqual([
			["SuperGrok", true],
			["Heavy", false],
		]);
		expect(grok.map((a) => a.id)).toEqual([slotId, waitingId]);
	});
	it("switching keeps the connection row (chat routes point at it) and re-seals the tokens for it", async () => {
		const { rowId, slotId, waitingId } = await twoGrok();
		expect(await activateSubscriptionAccount(user, "grok", waitingId)).toBe(
			"switched",
		);
		expect(
			(await db.query("select id::text from model_connection")).rows,
		).toEqual([{ id: rowId }]);
		expect(await slotTokens()).toMatchObject({
			connectionId: rowId,
			accessToken: "access-2",
			refreshToken: "refresh-2",
		});
		const grok = await grokOnly();
		expect(grok.find((a) => a.active)).toMatchObject({
			id: waitingId,
			label: "Heavy",
		});
		expect(grok.find((a) => !a.active)?.id).toBe(slotId);
		await activateSubscriptionAccount(user, "grok", slotId);
		expect(await slotTokens()).toMatchObject({
			refreshToken: "refresh-1",
			connectionId: rowId,
		});
	});
	it("a plan limit moves to the other account, resting this one until xAI's own reset", async () => {
		const { slotId, waitingId } = await twoGrok();
		const now = Date.now();
		await db.query("update model_connection set plan_usage=$1::jsonb", [
			JSON.stringify({
				readAt: now,
				windows: [{ id: "weekly", usedPercent: 100, resetsAt: now + 3 * HOUR }],
			}),
		]);
		const result = await rotateAfterLimit(user, "grok", {
			reportedResetAt: null,
			now,
		});
		expect(result).toMatchObject({
			kind: "rotated",
			to: { accountId: waitingId },
		});
		expect((await slotTokens()).refreshToken).toBe("refresh-2");
		const rested = (await listSubscriptionAccounts(user, now)).find(
			(a) => a.id === slotId,
		);
		expect(rested?.state).toBe("limited");
		expect(rested?.limitedUntil).toBeCloseTo(now + 3 * HOUR, -4);
	});
	it("a user with one Grok account is untouched", async () => {
		const rowId = randomUUID();
		await db.query(
			`insert into model_connection(id,user_id,provider,label,kind,status,sealed_credential)
			 values($1,$2,'compatible','Grok plan','xai-subscription','ready',$3)`,
			[rowId, user, await sealXai(xaiTokens(1, rowId))],
		);
		expect(
			(await rotateAfterLimit(user, "grok", { reportedResetAt: null })).kind,
		).toBe("none");
		expect(
			await prepareTurnAccount(user, "grok", {
				sessionId: await chatFor(),
				turnId: null,
			}),
		).toBeNull();
	});
	it("renames and orders both, and disconnecting the main one promotes the next", async () => {
		const { rowId, slotId, waitingId } = await twoGrok();
		await renameSubscriptionAccount(user, "grok", slotId, "Personal");
		await renameSubscriptionAccount(user, "grok", waitingId, "Team");
		await reorderSubscriptionAccounts(user, "grok", [waitingId, slotId]);
		expect((await grokOnly()).map((a) => a.label)).toEqual([
			"Team",
			"Personal",
		]);
		await removeSubscriptionAccount(user, "grok", slotId);
		const left = await grokOnly();
		expect(left).toHaveLength(1);
		expect(left[0]).toMatchObject({ id: waitingId, active: true });
		expect((await slotTokens()).connectionId).toBe(rowId);
		await removeSubscriptionAccount(user, "grok", waitingId);
		expect(
			(await db.query("select 1 from model_connection")).rows,
		).toHaveLength(0);
	});
	it("adds another account only when a main one exists, up to the cap", async () => {
		const client = {
			query: (sql: string, values?: unknown[]) =>
				holder.query(sql, values as unknown[]),
		};
		const add = (label: string) =>
			addGrokAccount(client, user, {
				label,
				sealedAuth: (id, rowId) =>
					extraAccountSeal(user, id, xaiTokens(9, rowId)),
			});
		expect(await add("Early")).toBe("no-main");
		await twoGrok();
		expect(await add("Third")).toBe("added");
		expect(await add("Fourth")).toBe("added");
		expect(await add("Fifth")).toBe("added");
		expect(await add("Sixth")).toBe("full");
	});
});
