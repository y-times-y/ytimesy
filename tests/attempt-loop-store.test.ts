import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { AttemptLoopState } from "../src/domain/attempt-loop";
import {
	attemptLoopDeadline,
	attemptLoopStates,
	loadAttemptLoopState,
	saveAttemptLoopDeadline,
	saveAttemptLoopState,
	takeLoopSubagentReport,
} from "../src/server/adapters/attempt-loop-store";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({
		query: async (sql: string, params?: unknown[]) => {
			const result = await db.query(sql, params);
			return { ...result, rowCount: result.affectedRows ?? result.rows.length };
		},
	}),
}));

const parent = "00000000-0000-4000-8000-000000000001";
const child = "00000000-0000-4000-8000-000000000002";
const event = "00000000-0000-4000-8000-0000000000e1";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated");
	await db.exec(
		"create table agent_session(id uuid primary key, turn_status text, items jsonb)",
	);
	for (const file of [
		"20260923010000_agent_task_command_receipts.sql",
		"20260923013000_agent_task_command_heartbeat.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	// The columns the store touches, as in 20260921231000 and 20261001120000.
	await db.exec(`create table agent_task_event (
		id uuid primary key, parent_session_id uuid, child_session_id uuid,
		event_type text, payload jsonb, status text not null default 'pending',
		delivered_at timestamptz, last_error text, created_at timestamptz default now())`);
	await db.exec(`create table agent_peer_inbox (
		id text primary key, recipient_id uuid, message text,
		accepted boolean not null default false)`);
	await db.exec(
		`insert into agent_session(id, turn_status, items) values('${parent}','running','[]'),('${child}','idle','[]')`,
	);
});
afterAll(() => db.close());

const state = (turnId: string, attempt: number): AttemptLoopState => ({
	version: 1,
	turnId,
	max: 3,
	phase: "attempting",
	attempt,
	startedAt: 1,
	deadlineAt: 2,
	tokenBudget: 5_000_000,
	checkpoint: {
		cwd: "/w",
		tree: "t",
		indexTree: "i",
		head: "h",
		ref: "refs/ytimesy/attempts/x-base",
	},
	listenersAtStart: [],
	baseMessageCount: null,
	attemptStartedAt: 1,
	usageAtAttemptStart: null,
	candidates: [],
});

it("keeps one state per turn, replaced on save, NUL-safe", async () => {
	expect(await loadAttemptLoopState(parent, "turn-1")).toBeNull();
	await saveAttemptLoopState(parent, state("turn-1", 1));
	await saveAttemptLoopState(parent, {
		...state("turn-1", 2),
		candidates: [
			{
				n: 1,
				startedAt: 1,
				endedAt: 2,
				snapshot: state("x", 1).checkpoint,
				cutOff: false,
				report: `binary ${String.fromCharCode(0)} output`,
				builderUsage: null,
				checker: null,
				verdict: null,
			},
		],
	});
	const loaded = await loadAttemptLoopState(parent, "turn-1");
	expect(loaded?.attempt).toBe(2);
	expect(loaded?.candidates[0].report).toBe("binary � output");
	await saveAttemptLoopState(parent, state("turn-2", 1));
	expect((await attemptLoopStates(parent)).map((s) => s.turnId)).toEqual([
		"turn-1",
		"turn-2",
	]);
});

it("stores a runner's deadline", async () => {
	expect(await attemptLoopDeadline(parent)).toBeNull();
	await saveAttemptLoopDeadline(parent, 1_700_000_000_000);
	expect(await attemptLoopDeadline(parent)).toBe(1_700_000_000_000);
	// The deadline row is not a loop state.
	expect(await attemptLoopStates(parent)).toHaveLength(2);
});

it("takes a checker's report and keeps it out of the builder's inbox", async () => {
	expect(await takeLoopSubagentReport(parent, child)).toBeNull();
	await db.query(
		`insert into agent_task_event(id,parent_session_id,child_session_id,event_type,payload,status)
		 values($1,$2,$3,'completed',$4,'delivering')`,
		[event, parent, child, JSON.stringify({ message: '{"verdict":"pass"}' })],
	);
	await db.query(
		"insert into agent_peer_inbox(id,recipient_id,message) values($1,$2,'staged')",
		[event, parent],
	);
	expect(await takeLoopSubagentReport(parent, child)).toEqual({
		outcome: "completed",
		report: '{"verdict":"pass"}',
	});
	expect((await db.query("select * from agent_peer_inbox")).rows).toEqual([]);
	expect((await db.query("select status from agent_task_event")).rows).toEqual([
		{ status: "delivered" },
	]);
	expect(await takeLoopSubagentReport(parent, child)).toBeNull();
});
