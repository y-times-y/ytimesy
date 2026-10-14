import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type ApiTurn,
	cancelApiTurn,
	cancelWaitingApiTurn,
	expireApiTurnLeases,
	finalizeApiTurn,
} from "./api-turns";

const holder = vi.hoisted(() => ({ db: null as unknown, capture: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder.db }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: async () => {},
}));
vi.mock("./analytics", () => ({ captureServerAnalytics: holder.capture }));

let db: PGlite;
const parent = randomUUID();
const child = randomUUID();
beforeEach(async () => {
	holder.capture.mockReset();
	db = new PGlite();
	holder.db = db;
	await db.exec(`create table agent_session(id uuid primary key,user_id text,harness text,parent_session_id uuid,task_access text,task_state text,turn_status text,items jsonb default '[]',updated_at timestamptz);
	create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,items jsonb default '[]',cancel_requested boolean default false,lease_id uuid,heartbeat_at timestamptz,executor text,created_at timestamptz default now(),updated_at timestamptz);`);
	await db.query(
		`insert into agent_session(id,user_id,harness,parent_session_id,task_access,turn_status) values
		($1,'alice','codex',null,null,'running'),($2,'alice','api',$1,'read_write','running')`,
		[parent, child],
	);
});
afterEach(() => db.close());

it("captures turn_finished with role, outcome and measured duration when a turn settles", async () => {
	const id = randomUUID();
	const lease = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,lease_id,heartbeat_at,created_at) values($1,$2,'alice','running',$3,now(),now()-interval '2 seconds')`,
		[id, child, lease],
	);
	expect(
		await finalizeApiTurn(
			{ id, lease_id: lease, user_id: "alice" } as ApiTurn,
			"completed",
			[],
		),
	).toBe("completed");
	expect(holder.capture).toHaveBeenCalledOnce();
	const [user, event, properties, identity] = holder.capture.mock.calls[0];
	expect([user, event]).toEqual(["alice", "turn_finished"]);
	expect(properties).toMatchObject({
		runtime: "api",
		role: "builder",
		outcome: "completed",
	});
	expect(properties.duration_ms).toBeGreaterThanOrEqual(1_900);
	expect(identity.key).toBe(`turn:${id}:finished`);
});

it("captures a stopped queued turn as cancelled and a lost worker as failed", async () => {
	const queued = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state) values($1,$2,'alice','queued')`,
		[queued, parent],
	);
	expect(await cancelApiTurn("alice", parent)).toEqual([
		{ id: queued, lease_id: null },
	]);
	expect(holder.capture.mock.calls[0][2]).toMatchObject({
		runtime: "codex",
		role: "lead",
		outcome: "cancelled",
	});
	holder.capture.mockReset();
	const lost = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,heartbeat_at,executor) values($1,$2,'alice','running',now()-interval '1 hour','node')`,
		[lost, child],
	);
	await expireApiTurnLeases();
	expect(holder.capture.mock.calls[0][2]).toMatchObject({ outcome: "failed" });
	expect(holder.capture.mock.calls[0][3].key).toBe(`turn:${lost}:finished`);
});

it("keeps a chat running when Stop cancels a waiting turn while another still runs", async () => {
	const waiting = randomUUID();
	const lease = randomUUID();
	const insertWaiting = () =>
		db.query(
			`insert into api_turn(id,session_id,user_id,state,cancel_requested,lease_id,executor) values($1,$2,'alice','running',true,$3,'durable-object')`,
			[waiting, child, lease],
		);
	await insertWaiting();
	const active = randomUUID();
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,cancel_requested,executor) values($1,$2,'alice','running',true,'durable-object')`,
		[active, child],
	);
	expect(await cancelWaitingApiTurn(waiting, lease)).toBe(true);
	const status = async () =>
		(
			await db.query<{ turn_status: string; task_state: string | null }>(
				"select turn_status,task_state from agent_session where id=$1",
				[child],
			)
		).rows[0];
	expect(await status()).toMatchObject({ turn_status: "running" });
	expect(holder.capture.mock.calls[0][2]).toMatchObject({
		outcome: "cancelled",
	});
	// Once nothing else runs, cancelling the waiting turn settles the chat idle.
	await db.query("update api_turn set state='cancelled' where id=$1", [active]);
	await db.query("delete from api_turn where id=$1", [waiting]);
	await insertWaiting();
	expect(await cancelWaitingApiTurn(waiting, lease)).toBe(true);
	expect(await status()).toEqual({ turn_status: "idle", task_state: "idle" });
});
