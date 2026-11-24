import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { ModelMessage } from "ai";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { sendQueuingBehindRace } from "../services/send-race";
import {
	type ApiTurn,
	abandonApiTurn,
	checkpointApiTurn,
	claimApiTurn,
	enqueueApiTurn,
	expireApiTurnLeases,
	finalizeApiTurn,
	MAX_BOX_TURN_TAKEOVERS,
	renewApiTurn,
	requeueInterruptedBoxTurns,
} from "./api-turns";
import {
	chatsWithReleasableHeldSends,
	QUEUED_CLAIM_TTL_MS,
	type QueuedUserSend,
	queueUserMessageWhileRunning,
	restoreQueuedUserMessages,
	takeNextQueuedUserMessages,
} from "./queued-user-messages";

/**
 * Fault injection against the real queue and lease SQL on PGlite: a user
 * message is never lost and a turn's lease is always recoverable. Faults are
 * injected by direct row updates (a stale heartbeat, a lapsed claim) instead
 * of timers, since the SQL reads the database clock.
 *
 * PGlite has one connection, so the pool below serializes whole transactions
 * (a held client keeps the lock until release). Two racing sends therefore
 * run one after the other, which is what the chat row's `for update` makes
 * them do in Postgres; the lock itself is not exercised here.
 */
const holder = vi.hoisted(() => ({
	query: vi.fn(),
	connect: vi.fn(),
}));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));
vi.mock("./turn-history-mirror", () => ({ mirrorTurnHistory: vi.fn() }));
vi.mock("./turn-runner-boxes", () => ({
	boxRoutingFacts: vi.fn(),
	turnRunnerBoxAlive: vi.fn(async () => false),
}));
vi.mock("./infrastructure-usage", () => ({
	assertUsageWindowsOpen: vi.fn(async () => {}),
}));
vi.mock("./training-consent", () => ({
	trainingEligibleAtTurnStart: () => "false",
}));
vi.mock("./conversation-recovery", () => ({
	recordConversationPoint: vi.fn(async () => {}),
	storePointMessages: vi.fn(async () => null),
	turnMessagesObject: vi.fn(() => null),
	recoveredConversation: vi.fn(async () => null),
}));
vi.mock("../services/turn-analytics", () => ({
	captureTurnStarted: vi.fn(),
	captureTurnFinished: vi.fn(),
}));

const USER = "alice";
const MODEL = "connection|model";
const connection = randomUUID();
const REVISION = "rev-1";

let db: PGlite;
let chat: string;
let tail: Promise<void>;

/** One connection: a caller owns it from acquire to release. */
function acquire() {
	let release!: () => void;
	const previous = tail;
	tail = new Promise<void>((resolve) => {
		release = resolve;
	});
	return previous.then(() => release);
}
async function run(sql: string, values?: unknown[]) {
	// A multi-statement batch (claimApiTurn) goes through exec.
	if (!values && sql.startsWith("begin;")) {
		const results = await db.exec(sql);
		return results.map((result) => ({
			...result,
			rowCount: result.affectedRows ?? result.rows.length,
		}));
	}
	const result = await db.query(sql, values);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
}

beforeEach(async () => {
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	tail = Promise.resolve();
	db = new PGlite();
	await db.exec(`
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,parent_session_id uuid,task_state text,task_access text,chat_role text,archived_at timestamptz,harness text,listed_model_id text,items jsonb not null default '[]',turn_status text default 'idle',items_rev bigint not null default 0,updated_at timestamptz default now());
	 create table project(id uuid primary key,user_id text,y_enabled boolean);
	 create table workspace(id uuid primary key,user_id text,project_id uuid,status text,provider_ref text,template_snapshot_id text);
	 create table model_connection(id uuid primary key,user_id text,revision text);
	 create table agent_task_command_receipt(parent_session_id uuid,request_id text,status text,response jsonb);
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default clock_timestamp());
	 create table api_turn(id uuid primary key,session_id uuid not null,user_id text not null,connection_id uuid,model_id text not null,connection_revision text not null,state text not null,messages jsonb not null default '[]',items jsonb not null default '[]',cancel_requested boolean not null default false,lease_id uuid,heartbeat_at timestamptz,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default now(),idempotency_key text,executor text not null default 'node',settings jsonb,failover jsonb,training_eligible boolean not null default false,base_turn_id uuid,base_version text,base_count int,run_attempts int not null default 0,box_tool_identity text);
	 create unique index api_turn_one_active on api_turn(session_id) where state in ('queued','running');`);
	holder.query.mockImplementation(async (sql: string, values?: unknown[]) => {
		const release = await acquire();
		try {
			return await run(sql, values);
		} finally {
			release();
		}
	});
	holder.connect.mockImplementation(async () => {
		const release = await acquire();
		return {
			query: (sql: string, values?: unknown[]) => run(sql, values),
			release: () => release(),
		};
	});
	chat = randomUUID();
	const project = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,harness,project_id) values($1,$2,'api',$3)",
		[chat, USER, project],
	);
	await db.query(
		"insert into workspace values(gen_random_uuid(),$1,$2,'ready','vm',null)",
		[USER, project],
	);
	await db.query("insert into model_connection values($1,$2,$3)", [
		connection,
		USER,
		REVISION,
	]);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await db.close();
});

const userItem = (text: string, id = randomUUID()): SessionItem =>
	({ kind: "userMessage", id: SessionItemId(id), text }) as SessionItem;
const answerItem = (text: string): SessionItem =>
	({ kind: "agentMessage", id: randomUUID(), text }) as SessionItem;

const queuedSend = (item: SessionItem, released = true): QueuedUserSend => ({
	item: item as QueuedUserSend["item"],
	message: (item as { text: string }).text,
	harnessId: "api",
	modelId: MODEL,
	released,
});

/** The send path: starts a turn, or queues behind a running one (send-race.ts). */
async function sendMessage(text: string, id = randomUUID()) {
	const item = userItem(text, id);
	const attempt = Effect.promise(async () => {
		await enqueueApiTurn({
			sessionId: chat,
			userId: USER,
			connectionId: connection,
			revision: REVISION,
			modelId: MODEL,
			routeId: MODEL,
			messages: [{ role: "user", content: text }] as ModelMessage[],
			items: [],
			appendItems: [item],
			idempotencyKey: `send:${id}`,
		});
		return "started" as const;
	});
	const queueBehind = async () => {
		const result = await queueUserMessageWhileRunning(
			USER,
			chat,
			queuedSend(item),
		);
		return result === "queued" ? ("queued" as const) : null;
	};
	return {
		id,
		outcome: await Effect.runPromise(
			sendQueuingBehindRace(attempt, queueBehind),
		),
	};
}

/** What startQueuedUserTurn does: take the waiting messages, start their turn, restore them if it fails. */
async function deliverQueued() {
	const batch = await takeNextQueuedUserMessages(USER, chat);
	if (!batch.length) return [];
	try {
		await enqueueApiTurn({
			sessionId: chat,
			userId: USER,
			connectionId: connection,
			revision: REVISION,
			modelId: MODEL,
			routeId: MODEL,
			messages: [
				{ role: "user", content: batch.map((s) => s.message).join("\n\n") },
			] as ModelMessage[],
			items: [],
			appendItems: batch.map((s) => s.item),
			idempotencyKey: `deliver:${batch[0]?.item.id}`,
		});
	} catch (error) {
		await restoreQueuedUserMessages(chat, batch);
		throw error;
	}
	return batch;
}

const claim = () => claimApiTurn(2, 10, "node", chat);
async function claimed() {
	const turn = await claim();
	if (!turn) throw new Error("expected a queued turn to claim");
	return turn;
}
const finish = (turn: ApiTurn, answer: string) =>
	finalizeApiTurn(turn, "completed", [...turn.items, answerItem(answer)]);

const staleHeartbeat = (seconds: number, turnId?: string) =>
	db.query(
		`update api_turn set heartbeat_at=now()-($1::int * interval '1 second') where state='running' and ($2::uuid is null or id=$2::uuid)`,
		[seconds, turnId ?? null],
	);
const lapseClaims = () =>
	db.query(
		`update agent_peer_inbox set queued_send=jsonb_set(queued_send,'{claimedAt}',to_jsonb((extract(epoch from now())*1000)::bigint - ${QUEUED_CLAIM_TTL_MS + 1000}))`,
	);
const turns = async () =>
	(
		await db.query<{
			id: string;
			state: string;
			run_attempts: number;
			messages: { content: string }[];
		}>(
			"select id,state,run_attempts,messages from api_turn order by created_at",
		)
	).rows;
const inboxRows = async () =>
	(await db.query<{ id: string }>("select id from agent_peer_inbox")).rows;
const sessionRow = async () =>
	(
		await db.query<{ turn_status: string; items: SessionItem[] }>(
			"select turn_status,items from agent_session where id=$1",
			[chat],
		)
	).rows[0] as { turn_status: string; items: SessionItem[] };
const texts = async () =>
	(await sessionRow()).items.map((item) => (item as { text?: string }).text);
const userTexts = async () =>
	(await sessionRow()).items
		.filter((item) => item.kind === "userMessage")
		.map((item) => (item as { text: string }).text);

/** The invariants every scenario ends on. */
async function expectNothingLost(expectedUserTexts: string[]) {
	expect(await userTexts()).toEqual(expectedUserTexts);
	expect(await inboxRows()).toEqual([]);
	const active = (await turns()).filter((t) =>
		["queued", "running"].includes(t.state),
	);
	expect(active).toEqual([]);
	expect((await sessionRow()).turn_status).not.toBe("running");
}

it("(1) a delivery that dies between claiming a message and creating its turn: the claim lapses, the message is delivered exactly once", async () => {
	expect((await sendMessage("first")).outcome).toBe("started");
	const running = await claimed();
	expect((await sendMessage("second")).outcome).toBe("queued");
	await finish(running, "answer 1");

	// The drain claims "second", then dies: no turn, no restore.
	const dead = await takeNextQueuedUserMessages(USER, chat);
	expect(dead.map((s) => s.message)).toEqual(["second"]);
	expect(await inboxRows()).toHaveLength(1);
	expect((await turns()).filter((t) => t.state === "queued")).toHaveLength(0);
	// While the claim is live nobody else takes it (no double delivery) ...
	expect(await takeNextQueuedUserMessages(USER, chat)).toEqual([]);
	// ... and the sweep that finds waiting messages ignores it too.
	expect(await chatsWithReleasableHeldSends(undefined, 10)).toEqual([]);

	// The claim lapses; the sweep sees the chat again and a drain delivers.
	await lapseClaims();
	await db.query(
		"update agent_peer_inbox set created_at=now()-interval '5 minutes'",
	);
	expect(await chatsWithReleasableHeldSends(undefined, 10)).toEqual([
		expect.objectContaining({ sessionId: chat }),
	]);
	expect((await deliverQueued()).map((s) => s.message)).toEqual(["second"]);
	// Delivered exactly once: a second drain, a replay of the dead drain's own
	// delivery, and a restore of its stale batch change nothing.
	expect(await deliverQueued()).toEqual([]);
	await restoreQueuedUserMessages(chat, dead);
	expect(await inboxRows()).toHaveLength(0);
	const second = await claimed();
	expect(second.messages).toEqual([{ role: "user", content: "second" }]);
	await finish(second, "answer 2");
	expect(await userTexts()).toEqual(["first", "second"]);
	expect((await turns()).map((t) => t.state)).toEqual([
		"completed",
		"completed",
	]);
	await expectNothingLost(["first", "second"]);
});

it("(1b) a delivery whose turn cannot start is restored with its place in line", async () => {
	await sendMessage("first");
	const running = await claimed();
	await sendMessage("a");
	await sendMessage("b");
	await finish(running, "ok");
	const taken = await takeNextQueuedUserMessages(USER, chat, 1);
	// The chat is locked running again (a wake won the race): enqueue refuses.
	await db.query("update agent_session set turn_status='running' where id=$1", [
		chat,
	]);
	await expect(
		enqueueApiTurn({
			sessionId: chat,
			userId: USER,
			connectionId: connection,
			revision: REVISION,
			modelId: MODEL,
			routeId: MODEL,
			messages: [{ role: "user", content: "a" }] as ModelMessage[],
			items: [],
			appendItems: taken.map((s) => s.item),
		}),
	).rejects.toThrow();
	await restoreQueuedUserMessages(chat, taken);
	await db.query(
		"update agent_session set turn_status='completed' where id=$1",
		[chat],
	);
	expect(
		(await takeNextQueuedUserMessages(USER, chat, 1)).map((s) => s.message),
	).toEqual(["a"]);
});

it("(2) the box dies mid-turn: requeued with its checkpoint, a second box takes it, the old lease is refused everywhere", async () => {
	await sendMessage("build it");
	const first = await claimed();
	const saved: ModelMessage[] = [
		{ role: "user", content: "build it" },
		{ role: "assistant", content: "step 1 done" },
	];
	await checkpointApiTurn(first, saved, [...first.items, answerItem("step 1")]);

	// The box stops heartbeating for 45 s+.
	await staleHeartbeat(60);
	// While the turn waits for a new box the chat is still locked: a send queues.
	expect(await requeueInterruptedBoxTurns()).toBe(1);
	expect((await sendMessage("also this")).outcome).toBe("queued");
	const [requeued] = await turns();
	expect(requeued).toMatchObject({ state: "queued", run_attempts: 1 });
	expect(requeued?.messages).toEqual(saved);

	const second = await claimed();
	expect(second.id).toBe(first.id);
	expect(second.lease_id).not.toBe(first.lease_id);
	expect(second.messages).toEqual(saved);

	// The old lease's writes are all refused.
	expect(await renewApiTurn(first)).toBe(false);
	await expect(checkpointApiTurn(first, saved, first.items)).rejects.toThrow(
		/lease was lost/,
	);
	expect(await finalizeApiTurn(first, "completed", first.items)).toBeNull();
	expect(await abandonApiTurn(first.id, first.lease_id as string)).toBe(false);
	expect(await renewApiTurn(second)).toBe(true);
	expect((await turns())[0]?.state).toBe("running");

	expect(await finish(second, "all built")).toBe("completed");
	// The queued message is delivered after the resumed turn ends.
	expect((await deliverQueued()).map((s) => s.message)).toEqual(["also this"]);
	await finish(await claimed(), "and that");
	await expectNothingLost(["build it", "also this"]);
});

it("a claimed turn with a fresh heartbeat is not recovered just because its claim is old", async () => {
	await sendMessage("prepare the orchard");
	const first = await claimed();
	await db.query(
		"update api_turn set updated_at=now()-interval '90 seconds', heartbeat_at=now() where id=$1",
		[first.id],
	);

	// An empty checkpoint does not distinguish an unstarted turn from a model
	// request or external operation whose result has not yet been saved.
	expect(await requeueInterruptedBoxTurns()).toBe(0);
	expect(await claim()).toBeNull();
	expect((await turns())[0]).toMatchObject({
		state: "running",
		run_attempts: 0,
	});
	expect(await renewApiTurn(first)).toBe(true);
});

it("(3) a zombie 'running' turn with a stale heartbeat blocks a send: the message queues, never errors, and is delivered after takeover", async () => {
	await sendMessage("long job");
	await claimed();
	await staleHeartbeat(600);

	const sent = await sendMessage("are you there?");
	expect(sent.outcome).toBe("queued");
	expect(await inboxRows()).toHaveLength(1);
	// Nothing drains a running chat, even with a dead turn.
	expect(await takeNextQueuedUserMessages(USER, chat)).toEqual([]);

	// The sweep takes the zombie over; the message waits for the resumed turn.
	await expireApiTurnLeases();
	expect((await turns())[0]).toMatchObject({
		state: "queued",
		run_attempts: 1,
	});
	const resumed = await claimed();
	await finish(resumed, "done");
	expect((await deliverQueued()).map((s) => s.message)).toEqual([
		"are you there?",
	]);
	await finish(await claimed(), "yes");
	await expectNothingLost(["long job", "are you there?"]);
});

it("(4) two sends racing a turn start: exactly one starts, the other queues, both answered in order", async () => {
	const results = await Promise.all([sendMessage("one"), sendMessage("two")]);
	expect(results.map((r) => r.outcome).sort()).toEqual(["queued", "started"]);
	expect(await turns()).toHaveLength(1);
	const startedText = (await turns())[0]?.messages[0]?.content as string;
	const queuedText = startedText === "one" ? "two" : "one";

	await finish(await claimed(), `answer ${startedText}`);
	expect((await deliverQueued()).map((s) => s.message)).toEqual([queuedText]);
	await finish(await claimed(), `answer ${queuedText}`);

	await expectNothingLost([startedText, queuedText]);
	expect(await texts()).toEqual([
		startedText,
		`answer ${startedText}`,
		queuedText,
		`answer ${queuedText}`,
	]);
});

it("(5) renewal: ours inside the window keeps going, a long gap is refused yet recoverable by the sweep, a foreign lease is refused", async () => {
	await sendMessage("work");
	const turn = await claimed();
	// Inside the 45 s window with nobody having taken over: succeeds.
	await staleHeartbeat(40);
	expect(await renewApiTurn(turn)).toBe(true);
	// A foreign lease on the same turn is refused and does not refresh it.
	await staleHeartbeat(30);
	expect(await renewApiTurn({ ...turn, lease_id: randomUUID() })).toBe(false);
	const beat = async () =>
		(
			await db.query<{ age: number }>(
				"select extract(epoch from now()-heartbeat_at)::float as age from api_turn",
			)
		).rows[0]?.age ?? 0;
	expect(await beat()).toBeGreaterThan(25);

	// A gap past the window: the DB row still names our lease and nobody took
	// it over, yet renewal is refused (freshness is part of the fence) ...
	await staleHeartbeat(50);
	expect(await renewApiTurn(turn)).toBe(false);
	expect(await finalizeApiTurn(turn, "completed", turn.items)).toBeNull();
	// ... and that is recoverable, not stuck: the sweep requeues it under a new lease.
	expect(await requeueInterruptedBoxTurns()).toBe(1);
	const next = await claimed();
	expect(next.lease_id).not.toBe(turn.lease_id);
	expect(await renewApiTurn(turn)).toBe(false);
	expect(await renewApiTurn(next)).toBe(true);
	await finish(next, "ok");
	await expectNothingLost(["work"]);
});

it("(6) takeovers exhausted: the turn fails visibly, the queued message is still delivered and the chat is unlocked", async () => {
	await sendMessage("risky");
	for (let attempt = 0; attempt < MAX_BOX_TURN_TAKEOVERS; attempt++) {
		await claimed();
		await staleHeartbeat(60);
		expect(await requeueInterruptedBoxTurns()).toBe(1);
	}
	await claimed();
	await staleHeartbeat(60);
	expect((await sendMessage("follow-up")).outcome).toBe("queued");
	// Past the limit it is not requeued again ...
	expect(await requeueInterruptedBoxTurns()).toBe(0);
	// ... the sweep fails it.
	expect(await expireApiTurnLeases()).toBe(1);
	const [turn] = await turns();
	expect(turn).toMatchObject({
		state: "failed",
		run_attempts: MAX_BOX_TURN_TAKEOVERS,
	});
	const session = await sessionRow();
	expect(session.turn_status).toBe("failed");
	// What the user sees: their message stays in the transcript, followed by
	// an error item.
	expect(await userTexts()).toEqual(["risky"]);
	const error = session.items.find((item) => item.kind === "error") as
		| { message: string }
		| undefined;
	expect(error?.message).toMatch(/worker disconnected/);
	// GAP (reported, not weakened): the error does not tell the user to resend
	// and nothing resumes the turn on its own, so "risky" stays unanswered.
	expect(error?.message).not.toMatch(
		/resend|send (it|your message) again|try again/i,
	);
	expect((await turns()).some((t) => t.state === "queued")).toBe(false);

	// The queued follow-up is not stranded: the chat is unlocked and it starts.
	expect((await deliverQueued()).map((s) => s.message)).toEqual(["follow-up"]);
	await finish(await claimed(), "ok");
	expect(await userTexts()).toEqual(["risky", "follow-up"]);
	expect(await inboxRows()).toEqual([]);
});

it("(7) idempotency: the same send, delivery, finalize or abandon twice changes nothing", async () => {
	const id = randomUUID();
	await sendMessage("once", id);
	await sendMessage("once", id);
	expect(await turns()).toHaveLength(1);
	expect(await userTexts()).toEqual(["once"]);

	const turn = await claimed();
	// A replayed queue of the same message id while running stores one row.
	const waiting = userItem("later");
	const send = queuedSend(waiting);
	expect(await queueUserMessageWhileRunning(USER, chat, send)).toBe("queued");
	expect(await queueUserMessageWhileRunning(USER, chat, send)).toBe("queued");
	expect(await inboxRows()).toHaveLength(1);

	expect(await finish(turn, "done")).toBe("completed");
	const settled = await sessionRow();
	expect(await finish(turn, "done again")).toBeNull();
	expect(await abandonApiTurn(turn.id, turn.lease_id as string)).toBe(false);
	expect(await sessionRow()).toEqual(settled);

	// Delivering twice (same batch) starts one turn.
	const batch = await takeNextQueuedUserMessages(USER, chat);
	const deliver = () =>
		enqueueApiTurn({
			sessionId: chat,
			userId: USER,
			connectionId: connection,
			revision: REVISION,
			modelId: MODEL,
			routeId: MODEL,
			messages: [{ role: "user", content: "later" }] as ModelMessage[],
			items: [],
			appendItems: batch.map((s) => s.item),
			idempotencyKey: "deliver:later",
		});
	await deliver();
	await deliver();
	expect(await turns()).toHaveLength(2);
	expect(await userTexts()).toEqual(["once", "later"]);
	expect(await inboxRows()).toEqual([]);
	await finish(await claimed(), "ok");
	await expectNothingLost(["once", "later"]);
});
