import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitPushRequests } from "./git-push-requests";
import { machineGitTokens } from "./machine-git-tokens";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

const project = "5b3c9a40-0b5e-4d3a-9a51-2f7d6f1e8c11";
const chat = "6c4d0b51-1c6f-4e4b-8b62-3a8e7a2f9d22";
const head = "a".repeat(40);
const next = "b".repeat(40);
let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
		create table auth_user(id text primary key);
		create table project(id uuid primary key, user_id text not null references auth_user(id));
		create table agent_session(id uuid primary key, user_id text not null, project_id uuid not null, archived_at timestamptz);
		insert into auth_user values ('alice'), ('bob');
		insert into project values ('${project}', 'alice');
		insert into agent_session values ('${chat}', 'alice', '${project}', null);`);
	await db.exec(
		[
			"20261104120000_machine_git",
			"20261104130000_machine_git_token_holder",
			"20261104140000_push_request_answers",
		]
			.map((file) => readFileSync(`supabase/migrations/${file}.sql`, "utf8"))
			.join("\n"),
	);
	holder.query.mockImplementation((sql: string, values: unknown[]) =>
		db.query(sql, values),
	);
});
afterEach(() => db.close());

describe("machine git tokens", () => {
	it("keep only a hash, map to their live chat, and stop working once revoked or archived", async () => {
		const token = await machineGitTokens.mint({
			userId: "alice",
			sessionId: chat,
			expiresAt: new Date(Date.now() + 60_000),
		});
		const stored = await db.query<{ token_hash: string }>(
			"select token_hash from machine_git_token",
		);
		expect(stored.rows[0].token_hash).not.toContain(token.slice(4));
		expect(await machineGitTokens.owner(token)).toEqual({
			userId: "alice",
			sessionId: chat,
			projectId: project,
			holder: "step",
		});
		expect(await machineGitTokens.owner(`ygm_${"0".repeat(64)}`)).toBeNull();
		expect(await machineGitTokens.owner("not-a-token")).toBeNull();
		await db.exec(`update agent_session set archived_at=now()`);
		expect(await machineGitTokens.owner(token)).toBeNull();
		await db.exec(`update agent_session set archived_at=null`);
		await machineGitTokens.revokeForSession("alice", chat);
		expect(await machineGitTokens.owner(token)).toBeNull();
	});

	it("a terminal's token survives the turn's release, renews while open and goes when revoked", async () => {
		const expiresAt = new Date(Date.now() + 60_000);
		const step = await machineGitTokens.mint({
			userId: "alice",
			sessionId: chat,
			expiresAt,
		});
		const terminal = await machineGitTokens.mint({
			userId: "alice",
			sessionId: chat,
			expiresAt,
			holder: "terminal",
		});
		expect(await machineGitTokens.owner(terminal)).toMatchObject({
			holder: "terminal",
		});
		await machineGitTokens.revokeForSession("alice", chat);
		expect(await machineGitTokens.owner(step)).toBeNull();
		expect(await machineGitTokens.owner(terminal)).not.toBeNull();
		expect(
			await machineGitTokens.extend(
				terminal,
				new Date(Date.now() + 30 * 60_000),
			),
		).toBe(true);
		await machineGitTokens.revoke(terminal);
		expect(await machineGitTokens.owner(terminal)).toBeNull();
		// A revoked token is not renewed back to life.
		expect(
			await machineGitTokens.extend(terminal, new Date(Date.now() + 60_000)),
		).toBe(false);
	});

	it("stop working once expired", async () => {
		const token = await machineGitTokens.mint({
			userId: "alice",
			sessionId: chat,
			expiresAt: new Date(Date.now() - 1000),
		});
		expect(await machineGitTokens.owner(token)).toBeNull();
	});
});

describe("git push requests", () => {
	const push = {
		userId: "alice",
		projectId: project,
		owner: "acme",
		name: "app",
		branch: "main",
	};
	const refuse = (newId: string) =>
		gitPushRequests.recordRefused({
			...push,
			sessionId: chat,
			oldId: head,
			newId,
		});

	it("offer a refused push for one card, which then starts its lifetime", async () => {
		await refuse(next);
		const refused = await gitPushRequests.latestRefused({
			...push,
			owner: "ACME",
		});
		expect(refused).toMatchObject({ oldId: head, newId: next });
		expect(
			await gitPushRequests.latestRefused({ ...push, userId: "bob" }),
		).toBeNull();
		expect(
			await gitPushRequests.markRequested("bob", refused?.id ?? "", chat),
		).toBe(false);
		expect(
			await gitPushRequests.markRequested("alice", refused?.id ?? "", chat),
		).toBe(true);
		// Asked for once: no second card for the same refused push.
		expect(await gitPushRequests.latestRefused(push)).toBeNull();
		expect(
			await gitPushRequests.record("alice", refused?.id ?? ""),
		).toMatchObject({
			requestedAt: expect.any(Date),
			approvedAt: null,
			answer: null,
			sessionId: chat,
		});
	});

	it("start one server push and keep the first answer only", async () => {
		await refuse(next);
		const id = (await gitPushRequests.latestRefused(push))?.id ?? "";
		expect(await gitPushRequests.claimPush("bob", id)).toBe(false);
		expect(await gitPushRequests.claimPush("alice", id)).toBe(true);
		expect(await gitPushRequests.claimPush("alice", id)).toBe(false);
		expect(await gitPushRequests.answer("alice", id, "pushed", "bbbbbbb")).toBe(
			true,
		);
		expect(await gitPushRequests.answer("alice", id, "cancelled", "")).toBe(
			false,
		);
		expect(await gitPushRequests.record("alice", id)).toMatchObject({
			answer: "pushed",
			answerDetail: "bbbbbbb",
		});
	});

	it("tell a newer refused push of the branch apart", async () => {
		await refuse(next);
		await db.exec(
			"update git_push_request set created_at = now() - interval '1 minute'",
		);
		const first = await gitPushRequests.record(
			"alice",
			(await gitPushRequests.latestRefused(push))?.id ?? "",
		);
		expect(first && (await gitPushRequests.newerRefused("alice", first))).toBe(
			false,
		);
		await refuse("c".repeat(40));
		expect(first && (await gitPushRequests.newerRefused("alice", first))).toBe(
			true,
		);
	});

	it("hand each answered card's notice out once, and take one back", async () => {
		await refuse(next);
		const id = (await gitPushRequests.latestRefused(push))?.id ?? "";
		expect(await gitPushRequests.claimUnnoticed("alice", chat)).toEqual([]);
		await gitPushRequests.answer("alice", id, "cancelled", "");
		expect(await gitPushRequests.claimUnnoticed("alice", chat)).toEqual([
			expect.objectContaining({ id, answer: "cancelled" }),
		]);
		expect(await gitPushRequests.claimUnnoticed("alice", chat)).toEqual([]);
		await gitPushRequests.releaseNotice("alice", id);
		expect(await gitPushRequests.claimUnnoticed("alice", chat)).toHaveLength(1);
	});
});
