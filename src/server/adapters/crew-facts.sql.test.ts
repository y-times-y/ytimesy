import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readChatCrewScope, readThreadProgress } from "./crew-facts";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
const y2 = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`
	 create table project(id uuid primary key,user_id text,y_enabled boolean not null default false);
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,parent_session_id uuid,
	  title text,chat_role text,turn_status text default 'idle',archived_at timestamptz);
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,executor text,lease_id uuid,
	  created_at timestamptz default now(),updated_at timestamptz default now(),heartbeat_at timestamptz);`);
	await db.query(
		"insert into project(id,user_id,y_enabled) values($1,'alice',true)",
		[project],
	);
	await db.query(
		"insert into agent_session(id,user_id,project_id,title,chat_role) values($1,'alice',$2,'Y²','y2')",
		[y2, project],
	);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

async function chat(input: {
	title?: string;
	parent?: string;
	turnStatus?: string;
}) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,parent_session_id,title,turn_status) values($1,'alice',$2,$3,$4,$5)",
		[
			id,
			project,
			input.parent ?? null,
			input.title ?? "Fix login",
			input.turnStatus ?? "running",
		],
	);
	return id;
}

async function turn(
	sessionId: string,
	state: string,
	executor: string,
	updatedAgoMs: number,
	heartbeatAgoMs: number | null,
) {
	const id = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,executor,lease_id,updated_at,heartbeat_at)
		 values($1,$2,'alice',$3,$4,$5,now() - ($6::int * interval '1 millisecond'),
		  case when $7::int is null then null else now() - ($7::int * interval '1 millisecond') end)`,
		[
			id,
			sessionId,
			state,
			executor,
			randomUUID(),
			updatedAgoMs,
			heartbeatAgoMs,
		],
	);
	return id;
}

// What resolveModelConversation (executor.ts) asked before: the turn, by its
// durable-object lease. A box turn never matched, so its chat had no scope.
const BY_TURN = `select s.project_id from api_turn t join agent_session s on s.id=t.session_id
 where t.id=$1 and t.executor='durable-object'`;

it("resolves a thread whose turn runs on a box (the lookup by turn found nothing)", async () => {
	const thread = await chat({ title: "Fix login" });
	const boxTurn = await turn(thread, "running", "node", 0, 0);
	expect((await db.query(BY_TURN, [boxTurn])).rows).toEqual([]);
	expect(await readChatCrewScope("alice", thread)).toEqual({
		projectId: project,
		yEnabled: true,
		ySquaredId: y2,
		title: "Fix login",
	});
});

it("keeps helper chats out of the crew and other users' chats unread", async () => {
	const thread = await chat({});
	const helper = await chat({ parent: thread, title: "reader" });
	expect(await readChatCrewScope("alice", helper)).toMatchObject({
		projectId: project,
		yEnabled: false,
		ySquaredId: null,
	});
	expect(await readChatCrewScope("mallory", thread)).toBeNull();
});

it("reads real progress: renewals and checkpoints, and no active turn as settled", async () => {
	const working = await chat({});
	// Its last checkpoint is 30 minutes old (one long tool call), but the box
	// renewed its lease 10 s ago.
	await turn(working, "running", "node", 30 * 60_000, 10_000);
	const lost = await chat({ turnStatus: "failed" });
	await turn(lost, "failed", "node", 40 * 60_000, 40 * 60_000);
	const waiting = await chat({});
	await turn(waiting, "queued", "node", 5 * 60_000, null);
	const now = Date.now();
	const rows = await readThreadProgress("alice", [working, lost, waiting]);
	const by = new Map(rows.map((row) => [row.sessionId, row]));
	expect(by.get(working)).toMatchObject({ active: true, queued: false });
	expect(now - (by.get(working)?.progressAt ?? 0)).toBeLessThan(60_000);
	expect(by.get(lost)).toEqual({
		sessionId: lost,
		active: false,
		queued: false,
		progressAt: null,
		turnStatus: "failed",
	});
	expect(by.get(waiting)).toMatchObject({ active: true, queued: true });
	expect(await readThreadProgress("mallory", [working])).toEqual([]);
});
