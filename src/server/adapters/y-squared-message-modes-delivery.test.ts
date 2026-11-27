import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import {
	MID_TURN_USER_NOTE,
	planPeerInjection,
} from "#/domain/peer-inbox-injection";
import { ySquaredTools } from "#/server/services/y-squared-tools";
import {
	queueUserMessageWhileRunning,
	takeNextQueuedUserMessage,
} from "./queued-user-messages";
import { readPeerInbox } from "./server-peer-inbox";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(async () => {}),
}));

let db: PGlite;
let thread: string;
const started: string[] = [];
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,items jsonb not null default '[]',turn_status text default 'idle');
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default clock_timestamp());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	thread = randomUUID();
	started.length = 0;
	await db.query(
		"insert into agent_session(id,user_id,turn_status) values($1,'u','running')",
		[thread],
	);
});
afterEach(() => db.close());

/**
 * Y²'s tool wired to the real queue (the service's send, line for line:
 * a running thread gets queueUserMessageWhileRunning with released =
 * input.released; an idle one starts a turn) and a stop that ends the turn.
 */
function y2() {
	const status = async () =>
		(
			await db.query<{ turn_status: string }>(
				"select turn_status from agent_session where id=$1",
				[thread],
			)
		).rows[0]?.turn_status ?? "idle";
	return ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		machines: {} as never,
		modelId: "m",
		harnessId: "api",
		turnId: "t",
		deps: {
			metadata: (async () => ({
				id: thread,
				projectId: "p",
				title: "Worker",
				harness: "api",
				listedModelId: "m",
				parentSessionId: null,
				agentRole: null,
				turnStatus: await status(),
			})) as never,
			stop: (async () => {
				await db.query(
					"update agent_session set turn_status='idle' where id=$1",
					[thread],
				);
				return { turnStatus: "idle" };
			}) as never,
			send: (async (
				_m: unknown,
				_s: unknown,
				input: { text: string; released?: boolean },
			) => {
				if ((await status()) !== "running") {
					started.push(input.text);
					return { turnStatus: "running" };
				}
				await queueUserMessageWhileRunning("u", thread, {
					item: {
						kind: "userMessage",
						id: SessionItemId(randomUUID()),
						text: input.text,
					},
					message: input.text,
					harnessId: "api",
					modelId: "m",
					released: input.released === true,
				});
				return { turnStatus: "running" };
			}) as never,
		},
	});
}
const call = (
	tools: ReturnType<typeof y2>,
	args: Record<string, unknown>,
): Promise<string> =>
	(
		tools.message_thread as unknown as {
			execute: (a: unknown, o: unknown) => Promise<string>;
		}
	).execute(args, { toolCallId: "c", messages: [] });
const plan = (
	rows: Awaited<ReturnType<typeof readPeerInbox>>,
	claude: boolean,
) =>
	planPeerInjection(rows, [], {
		delivered: () => false,
		sentUserMessagesOnly: claude,
	});

it("steer: the working thread's next step reads the message, no extra turn", async () => {
	const reply = await call(y2(), {
		id: thread,
		text: "use tabs",
		mode: "steer",
	});
	expect(reply).toContain("STEERED");
	const rows = await readPeerInbox(thread);
	expect(rows.map((r) => r.message)).toEqual(["use tabs"]);
	// API-route step inbox read and a Claude Code run's hook both take it
	expect(plan(rows, false).delivering).toHaveLength(1);
	expect(plan(rows, true).injected.map((m) => m.content)).toEqual([
		`${MID_TURN_USER_NOTE}\n\nuse tabs`,
	]);
	// the turn is still the same one: nothing started, nothing queued for later
	expect(started).toEqual([]);
	expect(await takeNextQueuedUserMessage("u", thread)).toBeNull();
});

it("queue (explicit): invisible to the step read, waits for the turn's end", async () => {
	for (const args of [{ mode: "queue" }])
		await call(y2(), {
			id: thread,
			text: `later ${JSON.stringify(args)}`,
			...args,
		});
	expect(await readPeerInbox(thread)).toEqual([]);
	expect(await takeNextQueuedUserMessage("u", thread)).toBeNull();
	await db.query("update agent_session set turn_status='idle' where id=$1", [
		thread,
	]);
	const next = await takeNextQueuedUserMessage("u", thread);
	expect(next?.item.text).toBe('later {"mode":"queue"}');
});

it("interrupt: stops the running turn, then the message starts the next one", async () => {
	const reply = await call(y2(), {
		id: thread,
		text: "stop that",
		mode: "interrupt",
	});
	expect(reply).toContain("INTERRUPTED");
	expect(started).toEqual(["stop that"]);
	expect(await readPeerInbox(thread)).toEqual([]);
});
