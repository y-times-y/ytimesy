import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HOUR_MS } from "#/domain/y-settled-threads";
import { ySquaredTools } from "../services/y-squared-tools";
import { logSettledDecisions, threadExtras } from "./y-settled-facts";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
const NOW = Date.now();
const hoursAgo = (h: number) => new Date(NOW - h * HOUR_MS).toISOString();
const PR = (n: number, url = `https://github.com/o/r/pull/${n}`) => ({
	kind: "notice",
	message: "",
	pullRequest: { state: "opened", number: n, url, draft: true, created: true },
});

async function seed(
	name: string,
	idle: number,
	items: Record<string, unknown>[],
	extra: { vm?: boolean; waitingOn?: string | null } = {},
) {
	const id = randomUUID();
	await db.query(
		`insert into agent_session(id,user_id,project_id,title,turn_status,provider_ref,waiting_on,updated_at,listed_model_id)
		 values($1,'u',$2,$3,'idle',$4,$5,$6,'m1')`,
		[
			id,
			project,
			name,
			extra.vm === false ? null : "vm",
			extra.waitingOn ?? null,
			hoursAgo(idle),
		],
	);
	for (const [position, item] of items.entries())
		await db.query(
			"insert into agent_session_item(session_id,position,kind,item_id,item,created_at) values($1,$2,$3,$4,$5,$6)",
			[
				id,
				position,
				item.kind,
				`i${position}`,
				JSON.stringify(item),
				hoursAgo(idle),
			],
		);
	return id;
}
const user = (text: string) => ({ kind: "userMessage", text });
const agent = { kind: "agentMessage", text: "done" };

beforeAll(async () => {
	db = new PGlite();
	await db.exec(`
	 create role anon; create role authenticated;
	 create table auth_user(id text primary key);
	 create table project(id uuid primary key);
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,parent_session_id uuid,title text,turn_status text,provider_ref text,machine_released_at timestamptz,waiting_on text,listed_model_id text,updated_at timestamptz);
	 create table agent_session_item(session_id uuid,position int,kind text,item_id text,item jsonb,created_at timestamptz default now(),primary key(session_id,position));
	 create table git_push_request(id uuid primary key default gen_random_uuid(),user_id text,session_id uuid,created_at timestamptz default now(),approved_at timestamptz,used_at timestamptz);
	 create table project_trace(id uuid primary key default gen_random_uuid(),session_id uuid,area text,created_at timestamptz default now());
	 insert into auth_user values('u'); insert into project values('${project}');`);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261127120000_y_thread_decision.sql",
			"utf8",
		),
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterAll(() => db.close());

describe("settled threads against a real SQL engine", () => {
	it("reads the facts, then the tool archives only the safe ones and logs each outcome", async () => {
		const landed = await seed("landed", 30, [user("ship"), agent, PR(1)]);
		const quiet = await seed("quiet", 40, [user("explain"), agent]);
		const unpushed = await seed("unpushed", 40, [
			user("x"),
			PR(2),
			{
				kind: "notice",
				message:
					"Changes are committed in this chat but were not pushed: no access.",
			},
		]);
		const repushed = await seed("repushed", 40, [
			user("x"),
			PR(5),
			{
				kind: "notice",
				message: "Changes are committed in this chat but were not pushed: x",
			},
			PR(5),
		]);
		const awaiting = await seed("awaiting", 40, [user("x"), agent]);
		await db.query(
			"insert into git_push_request(user_id,session_id) values('u',$1)",
			[awaiting],
		);
		const chatty = await seed("chatty", 40, [
			user("x"),
			agent,
			user("one more thing"),
		]);
		await db.query(
			"update agent_session_item set created_at=$2 where session_id=$1 and position=2",
			[chatty, hoursAgo(1)],
		);
		const edited = await seed("edited", 40, [
			user("x"),
			{ kind: "fileChange", changes: [] },
			agent,
		]);
		const gone = await seed("gone", 40, [user("x"), agent], { vm: false });
		await db.query(
			"insert into project_trace(session_id,area) values($1,'signup')",
			[quiet],
		);

		const ids = [
			landed,
			quiet,
			unpushed,
			repushed,
			awaiting,
			chatty,
			edited,
			gone,
		];
		const extras = new Map(
			(await threadExtras("u", project, ids)).map((e) => [e.id, e]),
		);
		expect(extras.get(landed)).toMatchObject({
			prUrl: "https://github.com/o/r/pull/1",
			unpushed: false,
			workspaceAlive: true,
			itemCount: 3,
		});
		expect(extras.get(unpushed)?.unpushed).toBe(true);
		expect(extras.get(repushed)?.unpushed).toBe(false);
		expect(extras.get(awaiting)?.pendingPush).toBe(true);
		expect(extras.get(chatty)?.lastUserAt).toBeGreaterThan(NOW - 2 * HOUR_MS);
		expect(extras.get(edited)?.mayHaveChanged).toBe(true);
		expect(extras.get(quiet)?.areas).toEqual(["signup"]);
		expect(extras.get(gone)?.workspaceAlive).toBe(false);
		expect(await threadExtras("someone-else", project, ids)).toEqual([]);

		const titles = new Map(
			ids.map((id, i) => [
				id,
				[
					"landed",
					"quiet",
					"unpushed",
					"repushed",
					"awaiting",
					"chatty",
					"edited",
					"gone",
				][i],
			]),
		);
		const archive = vi.fn(async () => undefined);
		const tools = ySquaredTools({
			userId: "u",
			projectId: project,
			selfId: "y2",
			deps: {
				now: () => NOW,
				list: (async () =>
					(
						await db.query<{
							id: string;
							title: string;
							updated_at: Date;
							waiting_on: string | null;
						}>(
							"select id::text id,title,updated_at,waiting_on from agent_session",
						)
					).rows.map((r) => ({
						id: r.id,
						title: r.title,
						waitingOn: r.waiting_on,
						workingSince: null,
						updatedAt: r.updated_at.toISOString(),
					}))) as never,
				crew: (() => null) as never,
				archive,
				prOpen: async (_u, _p, url) =>
					url.endsWith("/1") ? false : url.endsWith("/5") ? true : null,
				threadExtras,
				logDecisions: logSettledDecisions,
			},
		});
		const run = (name: string, input: unknown) =>
			(
				tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }
			).execute(input, { toolCallId: "c", messages: [] });
		const listed = await run("settled_threads", {});
		expect(listed).toContain("the rules would archive 3");
		const out = await run("archive_settled", { ids });
		const gone1 = (archive.mock.calls as unknown as string[][])
			.map((c) => titles.get(c[1] as string))
			.sort();
		expect(gone1).toEqual(["gone", "landed", "quiet"]);
		expect(out.split("\n")[0]).toMatch(/^Archived 3 settled threads/);
		const log = await db.query<{ decision: string; code: string }>(
			"select decision, code from y_thread_decision order by created_at",
		);
		expect(log.rows.filter((r) => r.decision === "archived")).toHaveLength(3);
		// kept rows from the listing are not duplicated by the refusals of the batch
		expect(
			log.rows.filter((r) => r.decision === "kept").map((r) => r.code),
		).toContain("unpushed-work");
		const refusedCodes = new Set(
			log.rows.filter((r) => r.decision === "refused").map((r) => r.code),
		);
		expect(refusedCodes.has("unpushed-work")).toBe(true);
		// the same decision is not written twice within a day
		const before = (
			await db.query("select count(*)::int n from y_thread_decision")
		).rows[0] as { n: number };
		await run("settled_threads", {});
		const after = (
			await db.query("select count(*)::int n from y_thread_decision")
		).rows[0] as { n: number };
		expect(after.n).toBe(before.n);
	});
});
