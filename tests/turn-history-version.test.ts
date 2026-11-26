import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionItem } from "../src/domain/session-item";
import {
	type ApiTurn,
	checkpointApiTurn,
	finalizeApiTurn,
	publishApiTurnProgress,
	replaceSettledTurnItem,
} from "../src/server/adapters/api-turns";
import { addSessionRequestUsage } from "../src/server/adapters/subagents";
import { withTurnHistoryMirror } from "../src/server/adapters/turn-history-mirror";
import { TurnHistoryCache } from "../src/server/edge/turn-history-cache";
import { durableObjectState } from "./support/durable-object-state";

/**
 * The chat Durable Object's local history copy against the real turn writes
 * (PGlite): it follows the turn's own writes and is dropped, never served,
 * once anyone else changed the turn's history in between.
 */
const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/server/adapters/database", () => ({
	database: () => holder,
}));
vi.mock("../src/server/adapters/conversation-progress-wake", () => ({
	wakeConversationProgress: vi.fn(),
}));

const SESSION = "00000000-0000-4000-8000-000000000001";
const TURN = "00000000-0000-4000-8000-0000000000aa";
let db: PGlite;
let cache: TurnHistoryCache;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,chat_role text,items jsonb not null default '[]',items_rev bigint not null default 0,updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,items jsonb not null default '[]',messages jsonb not null default '[]',
	 failover jsonb,lease_id text,cancel_requested boolean not null default false,heartbeat_at timestamptz default now(),updated_at timestamptz default now(),
	 base_turn_id uuid,base_version text,base_count integer,executor text,connection_id uuid,connection_revision text);
	 create function bump_items_rev() returns trigger language plpgsql as $$ begin new.items_rev := old.items_rev + 1; return new; end $$;
	 create trigger bump_items_rev before update of items on agent_session for each row execute function bump_items_rev();`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
	cache = new TurnHistoryCache(durableObjectState().ctx.storage.sql as never);
});
afterEach(() => db.close());

const user = (id: string) =>
	({ kind: "userMessage", id, text: id }) as unknown as SessionItem;
const agent = (id: string) =>
	({ kind: "agentMessage", id, text: id }) as unknown as SessionItem;
const messages = [{ role: "user" as const, content: "hi" }];

/** A running new-shape turn, loaded the way the chat's step loads it. */
async function running(chat: SessionItem[]) {
	await db.query(
		"insert into agent_session(id,user_id,items) values($1,'u',$2::jsonb)",
		[SESSION, JSON.stringify(chat)],
	);
	await db.query(
		`insert into api_turn(id,session_id,user_id,state,items,messages,lease_id)
		 values($1,$2,'u','running',$3::jsonb,$4::jsonb,'lease')`,
		[
			TURN,
			SESSION,
			JSON.stringify({ from: chat.at(-1)?.id }),
			JSON.stringify(messages),
		],
	);
	const version = await turnVersion();
	cache.write(TURN, version, { messages, items: chat });
	return {
		id: TURN,
		session_id: SESSION,
		user_id: "u",
		lease_id: "lease",
		items: chat,
		items_from: chat.at(-1)?.id,
	} as unknown as ApiTurn;
}
/** The version the step's small claim query reads. */
async function turnVersion() {
	return (
		await db.query<{ version: string }>(
			"select updated_at::text as version from api_turn where id=$1",
			[TURN],
		)
	).rows[0].version;
}
const mirrored = <T>(run: () => Promise<T>) =>
	withTurnHistoryMirror(
		// As the executor forwards it: everything the write reports.
		(...written) => cache.write(...written),
		run,
	);

it("follows the turn's own checkpoints and progress writes", async () => {
	const turn = await running([user("u1")]);
	const items = [user("u1"), agent("a1")];
	await mirrored(() => checkpointApiTurn(turn, messages, items));
	expect(cache.read(TURN, await turnVersion())).toEqual({ messages, items });
	const more = [...items, agent("a2")];
	await mirrored(() => publishApiTurnProgress(turn, more));
	expect(cache.read(TURN, await turnVersion())).toEqual({
		messages,
		items: more,
	});
});

it("drops the copy when another writer changed the turn before the step's next write", async () => {
	const done = { ...agent("pr"), text: "Opening pull request…" };
	const turn = await running([done, user("u1")]);
	// An earlier turn's pull-request item changes while this one runs.
	await replaceSettledTurnItem(turn, "pr", {
		...done,
		text: "Opened #4",
	} as SessionItem);
	// The step's own write follows, from its copy that predates that change.
	await mirrored(() =>
		publishApiTurnProgress(turn, [done, user("u1"), agent("a1")]),
	);
	expect(cache.read(TURN, await turnVersion())).toBeNull();
});

it("invalidates a running turn's copy when usage is added to its chat's items", async () => {
	await running([user("u1")]);
	const before = await turnVersion();
	expect(cache.read(TURN, before)).not.toBeNull();
	expect(
		await addSessionRequestUsage(SESSION, (items) => [
			{ ...(items[0] as object), apiUsage: { inputTokens: 1 } },
		]),
	).toBe(true);
	expect(await turnVersion()).not.toBe(before);
	expect(cache.read(TURN, await turnVersion())).toBeNull();
	const chat = await db.query<{ items: { apiUsage?: unknown }[] }>(
		"select items from agent_session",
	);
	expect(chat.rows[0].items[0].apiUsage).toEqual({ inputTokens: 1 });
});

it("adds usage to an idle chat without touching finished turns", async () => {
	await running([user("u1")]);
	await db.query("update api_turn set state='completed'");
	const before = await turnVersion();
	expect(
		await addSessionRequestUsage(SESSION, (items) => [...items, agent("x")]),
	).toBe(true);
	expect(await turnVersion()).toBe(before);
});

it("leaves the chat's copy at the revision of the turn's last write, for the next turn to start from", async () => {
	const turn = await running([user("u1")]);
	await mirrored(() =>
		checkpointApiTurn(turn, messages, [user("u1"), agent("a1")]),
	);
	const items = [user("u1"), agent("a1"), agent("a2")];
	await mirrored(() => publishApiTurnProgress(turn, items));
	cache.keepChatCopy();
	const revision = (
		await db.query<{ revision: string }>(
			"select items_rev::text as revision from agent_session where id=$1",
			[SESSION],
		)
	).rows[0].revision;
	expect(revision).toBe("2");
	expect(cache.chatCopy()).toEqual({ itemsRev: revision, items });
});

it("keeps the ended turn's history at the version its last write left, for the turn that continues it", async () => {
	await db.exec(
		"alter table agent_session add column turn_status text, add column task_state text, add column parent_session_id uuid, add column harness text, add column task_access text; alter table api_turn add column created_at timestamptz default now()",
	);
	const turn = await running([user("u1")]);
	const items = [user("u1"), agent("a1")];
	await mirrored(() => checkpointApiTurn(turn, messages, items));
	const final = [...messages, { role: "assistant" as const, content: "done" }];
	await mirrored(() => finalizeApiTurn(turn, "completed", items, final));
	cache.keepChatCopy();
	// What Postgres holds at that version, and the version a send reads.
	expect(cache.chatMessagesCopy()).toEqual({
		turnId: TURN,
		version: await turnVersion(),
		settled: true,
		messages: final,
	});
	// A turn whose last write was not mirrored here keeps no messages copy.
	await db.query("update api_turn set updated_at=now()+interval '1 second'");
	cache.clear();
	await mirrored(() => checkpointApiTurn(turn, messages, items)).catch(
		() => undefined,
	);
	cache.keepChatCopy();
	expect(cache.chatMessagesCopy()).toBeNull();
});
