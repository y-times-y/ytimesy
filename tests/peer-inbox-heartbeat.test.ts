import { PGlite } from "@electric-sql/pglite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	it,
	vi,
} from "vitest";
import { type ApiTurn, renewApiTurn } from "../src/server/adapters/api-turns";
import {
	observePeerInbox,
	peerInboxMayHaveMessages,
} from "../src/server/adapters/peer-inbox-observation";
import { injectServerPeerMessages } from "../src/server/adapters/server-peer-inbox";

let db: PGlite;
const statements: string[] = [];
const query = async (sql: string, params: unknown[] = []) => {
	statements.push(sql);
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const session = "00000000-0000-4000-8000-0000000000aa";
const turn = {
	id: "00000000-0000-4000-8000-0000000000bb",
	lease_id: "00000000-0000-4000-8000-0000000000cc",
	session_id: session,
} as ApiTurn;

beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key);
	create table api_turn(id uuid primary key,session_id uuid,lease_id uuid,state text,cancel_requested boolean default false,heartbeat_at timestamptz default now(),executor text default 'node',connection_id uuid,connection_revision text default 'fixture');
	create table agent_peer_inbox(id text primary key,recipient_id uuid not null,message text not null,accepted boolean not null default false,created_at timestamptz not null default now(),queued_send jsonb);
	create table agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb,primary key(parent_session_id,request_id));`);
});
beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	await db.exec("truncate agent_session,api_turn,agent_peer_inbox");
	await query("insert into agent_session values($1)", [session]);
	await query(
		"insert into api_turn(id,session_id,lease_id,state) values($1,$2,$3,'running')",
		[turn.id, session, turn.lease_id],
	);
	statements.length = 0;
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
	await db.close();
});

const checkpoint = vi.fn(async () => {});

it("skips the inbox read right after a heartbeat found it empty", async () => {
	expect(await renewApiTurn(turn)).toBe(true);
	expect(peerInboxMayHaveMessages(session)).toBe(false);
	statements.length = 0;
	const history = [{ role: "user" as const, content: "task" }];
	expect(await injectServerPeerMessages(session, history, checkpoint)).toBe(
		history,
	);
	expect(statements).toEqual([]);
});

it("reads and injects what a heartbeat saw waiting, and skips accepted rows", async () => {
	await query(
		"insert into agent_peer_inbox(id,recipient_id,message,accepted) values('old',$1,'done',true)",
		[session],
	);
	await renewApiTurn(turn);
	expect(peerInboxMayHaveMessages(session)).toBe(false);
	await query(
		"insert into agent_peer_inbox(id,recipient_id,message) values('m1',$1,'peer says hi')",
		[session],
	);
	await renewApiTurn(turn);
	expect(peerInboxMayHaveMessages(session)).toBe(true);
	const injected = await injectServerPeerMessages(
		session,
		[{ role: "user", content: "task" }],
		checkpoint,
	);
	expect(injected.at(-1)).toEqual({ role: "user", content: "peer says hi" });
	// The observation must start after the inbox write, not at the same frozen-clock tick.
	vi.setSystemTime(Date.now() + 1);
	await renewApiTurn(turn);
	expect(peerInboxMayHaveMessages(session)).toBe(false);
});

it("reads normally without a fresh negative observation", () => {
	const other = "00000000-0000-4000-8000-0000000000dd";
	expect(peerInboxMayHaveMessages(other)).toBe(true);
	observePeerInbox(other, 1_000, false);
	expect(peerInboxMayHaveMessages(other, 2_000)).toBe(false);
	expect(peerInboxMayHaveMessages(other, 2_501)).toBe(true);
	// An older answer arriving late never replaces a newer one.
	observePeerInbox(other, 3_000, true);
	observePeerInbox(other, 2_900, false);
	expect(peerInboxMayHaveMessages(other, 3_100)).toBe(true);
});
