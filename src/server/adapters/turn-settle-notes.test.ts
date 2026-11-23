import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { expireApiTurnLeases } from "./api-turns";
import {
	deliverTurnSettleNotesDirectly,
	type SettledElsewhere,
} from "./turn-settle-notes";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("./database", () => ({ database: () => holder.db }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: async () => {},
}));
vi.mock("./analytics", () => ({ captureServerAnalytics: vi.fn() }));

let db: PGlite;
const chat = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	holder.db = db;
	await db.exec(`create table agent_session(id uuid primary key,user_id text,harness text,parent_session_id uuid,task_access text,task_state text,turn_status text,items jsonb default '[]',items_rev bigint not null default 0,updated_at timestamptz);
	create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,messages jsonb default '[]',items jsonb default '[]',cancel_requested boolean default false,lease_id uuid,heartbeat_at timestamptz,executor text,run_attempts integer not null default 0,created_at timestamptz default now(),updated_at timestamptz);`);
	await db.query(
		"insert into agent_session(id,user_id,harness,turn_status) values($1,'alice','api','running')",
		[chat],
	);
});
afterEach(() => {
	deliverTurnSettleNotesDirectly(null);
	return db.close();
});

it("tells the chat's object when the lease sweep fails its turn (nothing else would)", async () => {
	const notes: SettledElsewhere[] = [];
	deliverTurnSettleNotesDirectly(async (note) => {
		notes.push(note);
	});
	const lost = randomUUID();
	// A box turn whose takeovers are used up: its box stopped renewing it.
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,heartbeat_at,executor,run_attempts)
		 values($1,$2,'alice','running',now()-interval '1 hour','node',3)`,
		[lost, chat],
	);
	expect(await expireApiTurnLeases()).toBe(1);
	expect(notes).toEqual([
		{ userId: "alice", sessionId: chat, turnId: lost, turnStatus: "failed" },
	]);
});

it("a note that cannot be delivered never fails the sweep", async () => {
	deliverTurnSettleNotesDirectly(async () => {
		throw new Error("object unreachable");
	});
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,heartbeat_at,executor)
		 values($1,$2,'alice','running',now()-interval '1 hour','durable-object')`,
		[randomUUID(), chat],
	);
	expect(await expireApiTurnLeases()).toBe(1);
	const status = await db.query<{ turn_status: string }>(
		"select turn_status from agent_session where id=$1",
		[chat],
	);
	expect(status.rows[0]?.turn_status).toBe("failed");
});
