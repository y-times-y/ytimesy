import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONVERSATION_FORK_STALE_SECONDS,
	type ConversationForkJournal,
	conversationForkStatus,
} from "#/domain/conversation-fork";
import { claimApiTurn } from "./api-turns";
import {
	bindConversationForkVm,
	conversationForkPending,
	failConversationFork,
	openConversationForkJournal,
	retryConversationForkJournal,
} from "./conversation-fork";

const holder = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const fork = randomUUID(),
	other = randomUUID(),
	project = randomUUID();
const journal: ConversationForkJournal = {
	state: "preparing",
	sourceSessionId: randomUUID(),
	messageId: "first",
	branch: "ytimesy/original-abcdef",
	attempt: 1,
};

beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,status text,provider_ref text,updated_at timestamptz default now());
 create table agent_task_command_receipt(parent_session_id uuid references agent_session(id) on delete cascade,request_id text,status text,response jsonb,created_at timestamptz default now(),completed_at timestamptz,updated_at timestamptz default now(),primary key(parent_session_id,request_id));
 create table api_turn(id text primary key,session_id uuid,user_id text,state text,executor text,cancel_requested boolean default false,lease_id text,heartbeat_at timestamptz,updated_at timestamptz,created_at timestamptz default now());`);
	for (const id of [fork, other])
		await db.query(
			"insert into agent_session(id,user_id,project_id,status) values($1,'alice',$2,'starting')",
			[id, project],
		);
	holder.query.mockImplementation(async (sql: string, values?: unknown[]) => {
		// The claim is one multi-statement batch without parameters.
		if (!values) {
			const results = await db.exec(sql);
			return results.map((result) => ({
				fields: result.fields,
				rows: result.rows,
			}));
		}
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	holder.connect.mockResolvedValue({ query: holder.query, release() {} });
	await openConversationForkJournal(holder, fork, journal);
});
afterEach(() => db.close());

const queueTurn = (id: string, sessionId: string, minutesAgo: number) =>
	db.query(
		`insert into api_turn(id,session_id,user_id,state,executor,created_at) values($1,$2,'alice','queued','node',now()-make_interval(mins => $3))`,
		[id, sessionId, minutesAgo],
	);

it("holds a forked chat's queued turn until its VM is bound, without holding other chats", async () => {
	await queueTurn("forked", fork, 2);
	await queueTurn("elsewhere", other, 1);
	expect(await conversationForkPending(fork)).toBe(true);
	// The older turn is the fork's; the claim passes it by.
	expect((await claimApiTurn(2, 8))?.id).toBe("elsewhere");
	expect(await claimApiTurn(2, 8)).toBeNull();
	expect(await bindConversationForkVm("alice", fork, 1, "vm-fork")).toBe(true);
	expect(await conversationForkPending(fork)).toBe(false);
	expect((await claimApiTurn(2, 8))?.id).toBe("forked");
	const row = (
		await db.query<{ provider_ref: string; status: string }>(
			"select provider_ref,status from agent_session where id=$1",
			[fork],
		)
	).rows[0];
	expect(row).toEqual({ provider_ref: "vm-fork", status: "ready" });
});

describe("a failed copy", () => {
	it("is retried as a new attempt; the old attempt can no longer bind or fail it", async () => {
		// Still preparing: nothing to retry.
		expect(await retryConversationForkJournal("alice", project, fork)).toBe(
			null,
		);
		await failConversationFork("alice", fork, journal, {
			message: "Couldn't fork this chat. Try again.",
			leftoverVm: "vm-old",
		});
		expect(await retryConversationForkJournal("bob", project, fork)).toBe(null);
		expect(await retryConversationForkJournal("alice", project, fork)).toBe(2);
		const saved = (
			await db.query<{ response: ConversationForkJournal }>(
				"select response from agent_task_command_receipt where parent_session_id=$1",
				[fork],
			)
		).rows[0].response;
		expect(saved).toMatchObject({
			state: "preparing",
			attempt: 2,
			leftoverVm: "vm-old",
		});
		expect(saved.message).toBeUndefined();
		// Attempt 1 finishing late changes nothing.
		await failConversationFork("alice", fork, journal, { message: "late" });
		expect(await bindConversationForkVm("alice", fork, 1, "vm-1")).toBe(false);
		expect(await bindConversationForkVm("alice", fork, 2, "vm-2")).toBe(true);
	});

	it("is retried when an attempt was interrupted while preparing", async () => {
		await db.query(
			"update agent_task_command_receipt set updated_at=now()-make_interval(secs => $1::double precision)",
			[CONVERSATION_FORK_STALE_SECONDS + 5],
		);
		expect(await retryConversationForkJournal("alice", project, fork)).toBe(2);
	});
});

it("shows preparing, a failure, or an interrupted copy as failed", () => {
	const now = Date.now();
	expect(conversationForkStatus(null, null, now)).toBeNull();
	expect(conversationForkStatus(journal, new Date(now), now)).toEqual({
		state: "preparing",
	});
	expect(
		conversationForkStatus(
			{ ...journal, state: "failed", message: "No capacity." },
			new Date(now),
			now,
		),
	).toEqual({ state: "failed", message: "No capacity." });
	expect(
		conversationForkStatus(
			journal,
			new Date(now - (CONVERSATION_FORK_STALE_SECONDS + 1) * 1000),
			now,
		),
	).toEqual({
		state: "failed",
		message: "Preparing the fork stopped. Try again.",
	});
});
