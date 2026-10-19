import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	bindPullRequestLinkSession,
	claimPullRequestWake,
	finishPullRequestWake,
	pullRequestLinkForOwner,
	recordPullRequestLink,
	stagePullRequestWakes,
} from "../src/server/adapters/pull-request-links";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));

const project = "00000000-0000-4000-8000-000000000001";
const workspace = "00000000-0000-4000-8000-000000000002";
const chat = "00000000-0000-4000-8000-000000000003";
const task = "00000000-0000-4000-8000-000000000004";
const link = "00000000-0000-4000-9000-000000000001";
const sha = "a".repeat(40);

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec(`
		delete from infrastructure_provider_statement; delete from infrastructure_vm_admission; delete from infrastructure_usage_reservation;
		delete from auth_user;
		insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('${project}','alice',1,2,'owner/app','main');
		insert into workspace(id,user_id,project_id,status) values('${workspace}','alice','${project}','ready');
		insert into agent_session(id,user_id,project_id,workspace_id,harness,status) values('${chat}','alice','${project}','${workspace}','codex','ready');
		insert into agent_session(id,user_id,project_id,workspace_id,harness,status,parent_session_id,task_access) values('${task}','alice','${project}','${workspace}','codex','ready','${chat}','read_write');
	`);
});

const record = (
	overrides: Partial<Parameters<typeof recordPullRequestLink>[0]> = {},
) =>
	recordPullRequestLink({
		id: link,
		userId: "alice",
		projectId: project,
		installationId: 2,
		repositoryId: 1,
		fullName: "owner/app",
		pullNumber: 12,
		headRef: "ytimesy/fix-ab12",
		baseRef: "main",
		originSessionId: chat,
		...overrides,
	});

const stage = (
	overrides: Partial<Parameters<typeof stagePullRequestWakes>[0]> = {},
) =>
	stagePullRequestWakes({
		repositoryId: 1,
		installationId: 2,
		pullNumbers: [12],
		deliveryId: "delivery-1",
		kind: "comment",
		sourceId: 99,
		headSha: null,
		...overrides,
	});

it("records a project's pull request once and shows it only to its owner", async () => {
	expect(await record()).toBe(link);
	// Reusing the open pull request keeps the first link (its description points there).
	expect(
		await record({
			id: "00000000-0000-4000-9000-000000000002",
			baseRef: "dev",
		}),
	).toBe(link);
	expect(await pullRequestLinkForOwner("alice", project, link)).toMatchObject({
		id: link,
		installationId: "2",
		repositoryId: "1",
		pullNumber: 12,
		headRef: "ytimesy/fix-ab12",
		baseRef: "dev",
		originSessionId: chat,
		sessionId: null,
	});
	expect(await pullRequestLinkForOwner("bob", project, link)).toBeNull();
	await expect(record({ userId: "bob" })).rejects.toThrow("not available");
	await db.exec("set role anon");
	await expect(db.query("select * from pull_request_link")).rejects.toThrow();
	await db.exec("reset role");
});

it("stages one wake per comment and per failed head, for linked pull requests only", async () => {
	await record();
	expect(await stage()).toBe(1);
	expect(await stage({ deliveryId: "redelivery" })).toBe(0);
	expect(await stage({ pullNumbers: [13], sourceId: 100 })).toBe(0);
	expect(await stage({ installationId: 3, sourceId: 101 })).toBe(0);
	expect(await stage({ kind: "ci", sourceId: 5, headSha: sha })).toBe(1);
	// A second failed check on the same push is the same wake.
	expect(await stage({ kind: "ci", sourceId: 6, headSha: sha })).toBe(0);
	const rows = await db.query<{ kind: string; due: boolean }>(
		"select kind, available_at<=now() as due from pull_request_wake order by kind",
	);
	expect(rows.rows).toEqual([
		{ kind: "ci", due: false },
		{ kind: "comment", due: true },
	]);
});

it("limits CI wake-ups per pull request and leaves a task's pull request to PR repair", async () => {
	await record();
	for (const n of [1, 2, 3])
		expect(
			await stage({ kind: "ci", sourceId: n, headSha: String(n).repeat(40) }),
		).toBe(1);
	expect(
		await stage({ kind: "ci", sourceId: 4, headSha: "4".repeat(40) }),
	).toBe(0);
	expect(await stage({ sourceId: 50 })).toBe(1);
	await db.exec("delete from pull_request_wake");
	await db.exec(`update pull_request_link set origin_session_id='${task}'`);
	expect(await stage({ kind: "ci", sourceId: 7, headSha: sha })).toBe(0);
	expect(await stage({ sourceId: 51 })).toBe(1);
});

it("claims a due wake once and records the outcome", async () => {
	await record();
	await stage();
	const wake = await claimPullRequestWake();
	expect(wake).toMatchObject({
		kind: "comment",
		sourceId: 99,
		dedupeKey: "comment:99",
		link: { id: link, userId: "alice", headRef: "ytimesy/fix-ab12" },
	});
	expect(await claimPullRequestWake()).toBeNull();
	if (!wake) throw new Error("wake missing");
	await finishPullRequestWake(wake, { status: "retry", reason: "GitHub down" });
	await db.exec("update pull_request_wake set available_at=now()");
	const again = await claimPullRequestWake();
	expect(again?.failures).toBe(1);
	await bindPullRequestLinkSession(link, chat);
	await finishPullRequestWake(wake, { status: "delivered", sessionId: chat });
	expect(
		(
			await db.query(
				"select w.status,w.session_id,l.session_id as bound from pull_request_wake w join pull_request_link l on l.id=w.link_id",
			)
		).rows,
	).toEqual([{ status: "delivered", session_id: chat, bound: chat }]);
	await db.exec("update pull_request_wake set available_at=now()");
	expect(await claimPullRequestWake()).toBeNull();
});
