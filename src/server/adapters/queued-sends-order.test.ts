import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	MID_TURN_USER_NOTE,
	PEER_INBOX_STEP_READ_LIMIT,
	planPeerInjection,
	QUEUED_MESSAGES_PER_CHAT_LIMIT,
} from "#/domain/peer-inbox-injection";
import {
	takeNextQueuedUserMessage as claimNextQueuedUserMessage,
	type QueuedUserSend,
	queueUserMessageWhileRunning,
	restoreQueuedUserMessage,
} from "./queued-user-messages";
import {
	acceptPeerInbox,
	readPeerInbox,
	stageServerPeerMessage,
} from "./server-peer-inbox";

/** Taking claims a message; creating its turn deletes it (enqueueApiTurn). The tests that read what is taken in turn finish each delivery. */
const settleDelivered = (batch: readonly { item: { id: string } }[]) =>
	db.query("delete from agent_peer_inbox where id=any($1::text[])", [
		batch.map((send) => `queued-user:${send.item.id}`),
	]);
const takeNextQueuedUserMessage = async (userId: string, sessionId: string) => {
	const next = await claimNextQueuedUserMessage(userId, sessionId);
	if (next) await settleDelivered([next]);
	return next;
};

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));

let db: PGlite;
let chat: string;
beforeEach(async () => {
	// clock_timestamp(): each insert gets its own time, so created_at orders them.
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,items jsonb not null default '[]',turn_status text default 'idle');
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default clock_timestamp());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	chat = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,turn_status) values($1,'alice','running')",
		[chat],
	);
});
afterEach(() => db.close());

const send = (text: string, released = false): QueuedUserSend => ({
	item: { kind: "userMessage", id: SessionItemId(randomUUID()), text },
	message: text,
	harnessId: "api",
	modelId: "connection|model",
	released,
});
const idle = () =>
	db.query("update agent_session set turn_status='idle' where id=$1", [chat]);
const drain = async () => {
	const texts: string[] = [];
	for (;;) {
		const next = await takeNextQueuedUserMessage("alice", chat);
		if (!next) return texts;
		texts.push(next.item.text);
	}
};
const plan = (
	rows: Awaited<ReturnType<typeof readPeerInbox>>,
	claude = false,
) =>
	planPeerInjection(rows, [], {
		delivered: () => false,
		sentUserMessagesOnly: claude,
	});

it("holds several queued messages and starts them one per turn, oldest first", async () => {
	for (const text of ["one", "two", "three"])
		expect(await queueUserMessageWhileRunning("alice", chat, send(text))).toBe(
			"queued",
		);
	// nothing is taken while the turn runs
	expect(await takeNextQueuedUserMessage("alice", chat)).toBeNull();
	await idle();
	expect(await drain()).toEqual(["one", "two", "three"]);
});

it("an interrupt's message waits first and the earlier queued ones keep their order behind it", async () => {
	for (const text of ["one", "two"])
		await queueUserMessageWhileRunning("alice", chat, send(text));
	await restoreQueuedUserMessage(chat, send("interrupt"));
	await idle();
	expect(await drain()).toEqual(["interrupt", "one", "two"]);
});

it("refuses a message past the per-chat cap, and still accepts a replay of one that is waiting", async () => {
	const first = send("m0");
	expect(await queueUserMessageWhileRunning("alice", chat, first)).toBe(
		"queued",
	);
	for (let i = 1; i < QUEUED_MESSAGES_PER_CHAT_LIMIT; i++)
		expect(
			await queueUserMessageWhileRunning("alice", chat, send(`m${i}`)),
		).toBe("queued");
	expect(await queueUserMessageWhileRunning("alice", chat, send("over"))).toBe(
		"full",
	);
	expect(await queueUserMessageWhileRunning("alice", chat, first)).toBe(
		"queued",
	);
	const { rows } = await db.query<{ n: number }>(
		"select count(*)::int as n from agent_peer_inbox where recipient_id=$1",
		[chat],
	);
	expect(rows[0]?.n).toBe(QUEUED_MESSAGES_PER_CHAT_LIMIT);
	// delivered (accepted) rows free room; a not-running chat is still "not-running"
	await db.query(
		"update agent_peer_inbox set accepted=true where id=(select id from agent_peer_inbox limit 1)",
	);
	expect(await queueUserMessageWhileRunning("alice", chat, send("fits"))).toBe(
		"queued",
	);
	await idle();
	expect(await queueUserMessageWhileRunning("alice", chat, send("late"))).toBe(
		"not-running",
	);
});

it("a released message or steering behind many waiting ones is not starved by the step read", async () => {
	for (let i = 0; i < PEER_INBOX_STEP_READ_LIMIT + 4; i++)
		await queueUserMessageWhileRunning("alice", chat, send(`wait${i}`));
	await stageServerPeerMessage(
		chat,
		"steer-1",
		"Message from a (1):\n\nfix\n\nCoordination message ID: s1",
	);
	await queueUserMessageWhileRunning("alice", chat, send("sent", true));
	const rows = await readPeerInbox(chat);
	// the waiting (unreleased) rows are not read: only what a step can take
	expect(rows.map((row) => row.message)).toEqual([
		"Message from a (1):\n\nfix\n\nCoordination message ID: s1",
		"sent",
	]);
	expect(plan(rows).delivering).toHaveLength(2);
	// a Claude Code run's hook takes only the released user message
	expect(plan(rows, true).injected.map((m) => m.content)).toEqual([
		`${MID_TURN_USER_NOTE}\n\nsent`,
	]);
});

it("more deliverable rows than one step reads are taken in order over the next steps", async () => {
	const total = PEER_INBOX_STEP_READ_LIMIT + 5;
	for (let i = 0; i < total; i++)
		await stageServerPeerMessage(
			chat,
			`s${String(i).padStart(2, "0")}`,
			`note ${i}`,
		);
	const seen: string[] = [];
	for (let step = 0; step < 3; step++) {
		const rows = await readPeerInbox(chat);
		if (!rows.length) break;
		expect(rows.length).toBeLessThanOrEqual(PEER_INBOX_STEP_READ_LIMIT);
		seen.push(...rows.map((row) => row.message));
		await acceptPeerInbox(
			chat,
			rows.map((row) => row.id),
		);
	}
	expect(seen).toEqual(Array.from({ length: total }, (_, i) => `note ${i}`));
});

it("a row without the new fields (old shape: no released) is still read and delivered mid-turn", async () => {
	const { message, ...stored } = send("old");
	await db.query(
		"insert into agent_peer_inbox(id,recipient_id,message,queued_send) values('queued-user:old',$1,$2,$3::jsonb)",
		[chat, message, JSON.stringify({ ...stored, released: undefined })],
	);
	const rows = await readPeerInbox(chat);
	expect(rows).toHaveLength(1);
	expect(plan(rows).delivering).toEqual(["queued-user:old"]);
});
