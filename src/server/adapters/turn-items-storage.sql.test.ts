import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SessionItem } from "#/domain/session-item";
import { planItemsWrite } from "./turn-items-storage";

/**
 * The SQL the turn writes run (checkpointApiTurn and finalizeApiTurn in
 * api-turns.ts) against a real Postgres (PGlite), with the migrations that
 * mirror agent_session.items into agent_session_item rows.
 */
const SESSION = "00000000-0000-4000-8000-000000000001";
const TURN = "00000000-0000-4000-8000-0000000000aa";

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,items jsonb not null default '[]',messages jsonb not null default '[]',failover jsonb,lease_id text,cancel_requested boolean not null default false,heartbeat_at timestamptz default now(),updated_at timestamptz default now(),created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261105100000_agent_session_items_rev",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
});
afterEach(() => db.close());

const item = (id: string, kind = "agentMessage", text = id) =>
	({ kind, id, text }) as unknown as SessionItem;
const user = (id: string) => item(id, "userMessage");

async function start(sessionItems: SessionItem[], turnItems: string) {
	await db.query(
		"insert into agent_session(id,user_id,items) values($1,'u',$2::jsonb)",
		[SESSION, JSON.stringify(sessionItems)],
	);
	await db.query(
		"insert into api_turn(id,session_id,state,items,lease_id) values($1,$2,'running',$3::jsonb,'lease')",
		[TURN, SESSION, turnItems],
	);
}

/** The checkpoint statement of checkpointApiTurn, with its items plan. */
async function checkpoint(
	turn: { items: SessionItem[]; items_from?: string },
	items: SessionItem[],
) {
	const write = planItemsWrite(turn, items, 4, "agent_session.items", 6);
	await db.query(
		`with saved as (update api_turn set messages=$3,items=${write.apiTurn},failover=coalesce($5::jsonb,failover),updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and not cancel_requested returning session_id,updated_at)
		 update agent_session set items=${write.session},updated_at=now() where id in(select session_id from saved)
		 returning (select updated_at::text from saved) as version`,
		[TURN, "lease", "[]", write.itemsText, null, ...write.extra],
	);
	return write;
}

const sessionItems = async () =>
	(
		await db.query<{ items: SessionItem[] }>(
			"select items from agent_session where id=$1",
			[SESSION],
		)
	).rows[0].items;
const ids = (items: SessionItem[]) => items.map((entry) => entry.id);
const rowIds = async () =>
	(
		await db.query<{ item_id: string }>(
			"select item_id from agent_session_item where session_id=$1 order by position",
			[SESSION],
		)
	).rows.map((row) => row.item_id);

it("appends the turn's items after the chat's earlier ones and leaves the turn row small", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	const write = await checkpoint({ items: before, items_from: "u2" }, [
		...before,
		item("n1"),
		item("n2"),
	]);
	expect(JSON.parse(write.itemsText)).toHaveLength(3);
	expect(ids(await sessionItems())).toEqual(["u1", "a1", "u2", "n1", "n2"]);
	expect(await rowIds()).toEqual(["u1", "a1", "u2", "n1", "n2"]);
	const row = await db.query<{ items: unknown }>(
		"select items from api_turn where id=$1",
		[TURN],
	);
	expect(row.rows[0].items).toEqual({ from: "u2" });
});

it("replaces its own slice on the next write, with an updated item", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	const turn = { items: before, items_from: "u2" };
	await checkpoint(turn, [...before, item("n1", "agentMessage", "draft")]);
	await checkpoint(turn, [
		...before,
		item("n1", "agentMessage", "final"),
		item("n2"),
	]);
	const saved = await sessionItems();
	expect(ids(saved)).toEqual(["u1", "a1", "u2", "n1", "n2"]);
	expect((saved[3] as unknown as { text: string }).text).toBe("final");
});

it("keeps an earlier item another writer replaced meanwhile", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	await db.query(
		`update agent_session set items=jsonb_set(items,'{1,text}','"edited elsewhere"') where id=$1`,
		[SESSION],
	);
	await checkpoint({ items: before, items_from: "u2" }, [
		...before,
		item("n1"),
	]);
	const saved = await sessionItems();
	expect((saved[1] as unknown as { text: string }).text).toBe(
		"edited elsewhere",
	);
	expect(ids(saved)).toEqual(["u1", "a1", "u2", "n1"]);
});

it("sends the whole list when the turn changed an earlier item", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	const changed = [
		user("u1"),
		item("a1", "agentMessage", "rewritten"),
		user("u2"),
	];
	const write = await checkpoint({ items: before, items_from: "u2" }, [
		...changed,
		item("n1"),
	]);
	expect(write.extra).toEqual([]);
	const saved = await sessionItems();
	expect((saved[1] as unknown as { text: string }).text).toBe("rewritten");
	expect(ids(saved)).toEqual(["u1", "a1", "u2", "n1"]);
});

it("appends when the turn's first item is no longer in the chat", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	await db.query(
		`update agent_session set items='[{"kind":"userMessage","id":"u1","text":"u1"}]'::jsonb where id=$1`,
		[SESSION],
	);
	await checkpoint({ items: before, items_from: "u2" }, [
		...before,
		item("n1"),
	]);
	expect(ids(await sessionItems())).toEqual(["u1", "u2", "n1"]);
});

it("finalizes through the same plan using the aliased session table", async () => {
	const before = [user("u1"), item("a1"), user("u2")];
	await start(before, '{"from":"u2"}');
	const turn = { items: before, items_from: "u2" };
	const done = [...before, item("n1")];
	const write = planItemsWrite(turn, done, 4, "s.items", 6);
	await db.query(
		`with saved as (update api_turn set state=case when cancel_requested then 'cancelled' else $3 end,items=${write.apiTurn},messages=coalesce($5::jsonb,messages),updated_at=now()
		 where id=$1 and lease_id=$2 and state='running' and heartbeat_at>=now()-interval '45 seconds' returning id,session_id,state,created_at)
		 update agent_session s set items=${write.session},turn_status=saved.state,updated_at=now() from saved where s.id=saved.session_id returning s.id`,
		[TURN, "lease", "completed", write.itemsText, null, ...write.extra],
	);
	expect(ids(await sessionItems())).toEqual(["u1", "a1", "u2", "n1"]);
	expect(
		(
			await db.query<{ turn_status: string }>(
				"select turn_status from agent_session where id=$1",
				[SESSION],
			)
		).rows[0].turn_status,
	).toBe("completed");
});

it("a legacy turn still writes the full list to both rows", async () => {
	const before = [user("u1"), item("a1")];
	await start(before, JSON.stringify(before));
	await checkpoint({ items: before }, [...before, item("n1")]);
	expect(ids(await sessionItems())).toEqual(["u1", "a1", "n1"]);
	const row = await db.query<{ items: SessionItem[] }>(
		"select items from api_turn where id=$1",
		[TURN],
	);
	expect(ids(row.rows[0].items)).toEqual(["u1", "a1", "n1"]);
});

/**
 * The enqueue statement of enqueueApiTurn (renumbered to the parameters it
 * uses: marker = its $15, items = its $8, used twice): the turn row's items
 * and the chat's items in one statement.
 */
async function enqueue(chatItems: SessionItem[], marker: string | null) {
	await db.query(
		"insert into agent_session(id,user_id,items) values($1,'u','[]'::jsonb)",
		[SESSION],
	);
	await db.query(
		`with queued as (insert into api_turn(id,session_id,state,messages,items) values($1,$2,'queued','[]'::jsonb,coalesce($3::jsonb,$4)))
		 update agent_session set items=$4 where id=$2`,
		[TURN, SESSION, marker, JSON.stringify(chatItems)],
	);
}

it("queues a durable-object turn with only its first-item marker, and the chat with the full items", async () => {
	const chat = [user("u1"), item("a1"), user("u2")];
	await enqueue(chat, '{"from":"u2"}');
	expect(ids(await sessionItems())).toEqual(["u1", "a1", "u2"]);
	const row = await db.query<{ items: unknown }>(
		"select items from api_turn where id=$1",
		[TURN],
	);
	expect(row.rows[0].items).toEqual({ from: "u2" });
});

it("queues any other turn with the full items in the turn row, as before", async () => {
	const chat = [user("u1"), user("u2")];
	await enqueue(chat, null);
	const row = await db.query<{ items: SessionItem[] }>(
		"select items from api_turn where id=$1",
		[TURN],
	);
	expect(ids(row.rows[0].items)).toEqual(["u1", "u2"]);
});

/** The step loader of the chat's Durable Object (executor.ts): the turn's history, from the chat for a new-shape row. */
const LOADER = `select t.messages,case when jsonb_typeof(t.items)='array' then t.items else s.items end as items
 from api_turn t join agent_session s on s.id=t.session_id where t.id=$1 and t.lease_id=$2`;
const MARKER =
	"select t.items->>'from' as items_from from api_turn t where t.id=$1";

it("loads a new-shape turn's history from the chat and reads its marker", async () => {
	const chat = [user("u1"), item("a1"), user("u2"), item("n1")];
	await start(chat, '{"from":"u2"}');
	const loaded = await db.query<{ items: SessionItem[] }>(LOADER, [
		TURN,
		"lease",
	]);
	expect(ids(loaded.rows[0].items)).toEqual(["u1", "a1", "u2", "n1"]);
	const marker = await db.query<{ items_from: string | null }>(MARKER, [TURN]);
	expect(marker.rows[0].items_from).toBe("u2");
});

it("loads a legacy turn's own items and reports no marker", async () => {
	const own = [user("u1"), item("a1")];
	await start([user("other")], JSON.stringify(own));
	const loaded = await db.query<{ items: SessionItem[] }>(LOADER, [
		TURN,
		"lease",
	]);
	expect(ids(loaded.rows[0].items)).toEqual(["u1", "a1"]);
	const marker = await db.query<{ items_from: string | null }>(MARKER, [TURN]);
	expect(marker.rows[0].items_from).toBeNull();
});

it("reads a finished subagent turn's items from the chat for a new-shape row", async () => {
	const chat = [user("u1"), item("report")];
	await start(chat, '{"from":"u1"}');
	const read = await db.query<{ items: SessionItem[] }>(
		`select case when jsonb_typeof(t.items)='array' then t.items else c.items end as items
		 from agent_session c join api_turn t on t.session_id=c.id where t.id=$1`,
		[TURN],
	);
	expect(ids(read.rows[0].items)).toEqual(["u1", "report"]);
});
