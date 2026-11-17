import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { steeringTexts } from "#/domain/agent-steering";
import { SessionItemId } from "#/domain/ids";
import { MESSAGE_ATTACHMENT_LIMITS } from "#/domain/message-attachment";
import { QUEUED_MESSAGES_PER_CHAT_LIMIT } from "#/domain/peer-inbox-injection";
import {
	type QueuedUserSend,
	queueUserMessageWhileRunning,
	releaseQueuedUserMessage,
	restoreQueuedUserMessages,
	takeNextQueuedUserMessages,
} from "./queued-user-messages";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));

let db: PGlite;
let chat: string;
beforeEach(async () => {
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

const attachment = (size = 10) => ({
	id: randomUUID(),
	name: "a.png",
	mediaType: "image/png",
	size,
});
const send = (
	text: string,
	extra: Partial<QueuedUserSend> & {
		attachments?: ReturnType<typeof attachment>[];
	} = {},
): QueuedUserSend => {
	const { attachments, ...rest } = extra;
	return {
		item: {
			kind: "userMessage",
			id: SessionItemId(randomUUID()),
			text,
			...(attachments ? { attachments } : {}),
		},
		message: text,
		harnessId: "api",
		modelId: "connection|model",
		released: false,
		...rest,
	};
};
const fromAgent = (title: string, word: string) => {
	const messageId = `${title}:${randomUUID()}`;
	const { text, runtimeText } = steeringTexts({
		sender: { kind: "parent", title, id: title.toLowerCase() },
		message: word,
		messageId,
	});
	return send(text, { message: runtimeText });
};
const queue = async (...sends: QueuedUserSend[]) => {
	for (const one of sends)
		expect(await queueUserMessageWhileRunning("alice", chat, one)).toBe(
			"queued",
		);
};
const idle = () =>
	db.query("update agent_session set turn_status='idle' where id=$1", [chat]);
const texts = (sends: QueuedUserSend[]) => sends.map((one) => one.item.text);
const waiting = async () =>
	(
		await db.query<{ message: string }>(
			"select message from agent_peer_inbox where recipient_id=$1 and not accepted order by created_at,id",
			[chat],
		)
	).rows.map((row) => row.message);

it("takes the waiting messages of one origin together, oldest first, and nothing while the turn runs", async () => {
	await queue(send("one"), send("two"), send("three"));
	expect(await takeNextQueuedUserMessages("alice", chat)).toEqual([]);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
		"two",
		"three",
	]);
	// delivered together: nothing is left, and a replay takes nothing
	expect(await waiting()).toEqual([]);
	expect(await takeNextQueuedUserMessages("alice", chat)).toEqual([]);
});

it("another user's chat is never taken", async () => {
	await queue(send("one"));
	await idle();
	expect(await takeNextQueuedUserMessages("mallory", chat)).toEqual([]);
	expect(await waiting()).toEqual(["one"]);
});

it("takes each message's own attachments: the turn's files are their union", async () => {
	const a = attachment();
	const b = attachment();
	await queue(
		send("one", { attachments: [a] }),
		send("two"),
		send("three", { attachments: [b] }),
	);
	await idle();
	const taken = await takeNextQueuedUserMessages("alice", chat);
	expect(taken.flatMap((one) => one.item.attachments ?? [])).toEqual([a, b]);
});

it("stops the merge at the attachment limits of one turn, leaving the rest waiting in order", async () => {
	const files = (n: number) => Array.from({ length: n }, () => attachment());
	await queue(
		send("one", { attachments: files(5) }),
		send("two", { attachments: files(3) }),
		send("three", { attachments: files(1) }),
		send("four"),
	);
	await idle();
	// 5 + 3 = the file limit; the next one's file would pass it
	expect(MESSAGE_ATTACHMENT_LIMITS.files).toBe(8);
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
		"two",
	]);
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"three",
		"four",
	]);
});

it("stops the merge at the total byte limit, but always takes the first message", async () => {
	const big = MESSAGE_ATTACHMENT_LIMITS.totalBytes - 5;
	await queue(
		send("one", { attachments: [attachment(big)] }),
		send("two", { attachments: [attachment(10)] }),
		send("three"),
	);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
	]);
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"two",
		"three",
	]);
});

it("does not merge an agent's queued message with the person's, nor two senders' with each other", async () => {
	await queue(
		send("mine 1"),
		send("mine 2"),
		fromAgent("Lead", "a"),
		fromAgent("Lead", "b"),
		fromAgent("Reviewer", "c"),
		send("mine 3"),
	);
	await idle();
	const batches: string[][] = [];
	for (;;) {
		const taken = await takeNextQueuedUserMessages("alice", chat);
		if (!taken.length) break;
		batches.push(
			taken.map((one) => one.item.text.split("\n")[2] ?? one.item.text),
		);
	}
	expect(batches).toEqual([
		["mine 1", "mine 2"],
		["a", "b"],
		["c"],
		["mine 3"],
	]);
});

it("does not merge messages for different models or settings", async () => {
	await queue(
		send("one"),
		send("two", { modelId: "connection|other" }),
		send("three", { modelId: "connection|other", variant: "high" }),
	);
	await idle();
	const sizes: number[] = [];
	for (;;) {
		const taken = await takeNextQueuedUserMessages("alice", chat);
		if (!taken.length) break;
		sizes.push(taken.length);
	}
	expect(sizes).toEqual([1, 1, 1]);
});

it("takes a setup request or a new chat's base branch alone", async () => {
	await queue(
		send("setup", { environmentSetup: true }),
		send("branch", { baseBranch: "main" }),
		send("plain 1"),
		send("plain 2"),
	);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"setup",
	]);
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"branch",
	]);
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"plain 1",
		"plain 2",
	]);
});

it("leaves held-for-setup messages out of the batch", async () => {
	await queue(send("one"));
	await db.query(
		`insert into agent_peer_inbox(id,recipient_id,message,queued_send) values('queued-user:held',$1,'held',$2::jsonb)`,
		[
			chat,
			JSON.stringify({
				item: {
					kind: "userMessage",
					id: "held",
					text: "held",
					heldForSetup: true,
				},
				harnessId: "api",
				modelId: "connection|model",
			}),
		],
	);
	await queue(send("two"));
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
		"two",
	]);
	expect(await waiting()).toEqual(["held"]);
});

it("steering one queued message leaves the others queued, and the turn's end merges only those", async () => {
	const [one, two, three] = [send("one"), send("two"), send("three")];
	await queue(one, two, three);
	const outcome = await releaseQueuedUserMessage("alice", chat, two.item.id);
	expect(outcome).toEqual({ status: "running" });
	const rows = (
		await db.query<{ message: string; released: string | null }>(
			"select message, queued_send->>'released' as released from agent_peer_inbox order by created_at,id",
		)
	).rows;
	expect(rows).toEqual([
		{ message: "one", released: "false" },
		{ message: "two", released: "true" },
		{ message: "three", released: "false" },
	]);
	// The running turn's step took the steered one (delivered mid-turn).
	await db.query(
		"update agent_peer_inbox set accepted=true where message='two'",
	);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
		"three",
	]);
});

it("respects the per-chat cap: a batch is at most the cap, the queue never exceeds it", async () => {
	for (let i = 0; i < QUEUED_MESSAGES_PER_CHAT_LIMIT; i++)
		await queue(send(`m${i}`));
	expect(await queueUserMessageWhileRunning("alice", chat, send("over"))).toBe(
		"full",
	);
	await idle();
	const first = await takeNextQueuedUserMessages("alice", chat, 3);
	expect(texts(first)).toEqual(["m0", "m1", "m2"]);
	const rest = await takeNextQueuedUserMessages("alice", chat);
	expect(rest).toHaveLength(QUEUED_MESSAGES_PER_CHAT_LIMIT - 3);
	expect(rest[0]?.item.text).toBe("m3");
	expect(rest.at(-1)?.item.text).toBe(`m${QUEUED_MESSAGES_PER_CHAT_LIMIT - 1}`);
});

it("puts a failed batch back in its order, ahead of everything waiting, and replays take it whole once", async () => {
	await queue(send("one"), send("two"), send("three"));
	await idle();
	const batch = await takeNextQueuedUserMessages("alice", chat);
	await db.query("update agent_session set turn_status='running' where id=$1", [
		chat,
	]);
	await queue(send("later"));
	await restoreQueuedUserMessages(chat, batch);
	// restoring twice (a replay) adds nothing
	await restoreQueuedUserMessages(chat, batch);
	expect(await waiting()).toEqual(["one", "two", "three", "later"]);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"one",
		"two",
		"three",
		"later",
	]);
});

it("a restored single message still goes first", async () => {
	await queue(send("one"));
	await restoreQueuedUserMessages(chat, [send("back")]);
	await idle();
	expect(texts(await takeNextQueuedUserMessages("alice", chat))).toEqual([
		"back",
		"one",
	]);
});

it("takes with one round trip", async () => {
	await queue(send("one"), send("two"));
	await idle();
	holder.query.mockClear();
	await takeNextQueuedUserMessages("alice", chat);
	expect(holder.query).toHaveBeenCalledTimes(1);
});
