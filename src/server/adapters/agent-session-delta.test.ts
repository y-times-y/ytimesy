import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { childTaskPublicItems } from "#/domain/child-task-activity";
import {
	applySessionDelta,
	type SessionReadDelta,
} from "#/domain/session-delta";
import type { SessionItem } from "#/domain/session-item";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { sessionDeltaChange } from "../services/session-delta-change";
import {
	transcriptDeltaForOwner,
	transcriptTokenForOwner,
} from "./agent-session-delta";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	 create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,archived_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());
	 create table agent_peer_inbox(id text primary key,recipient_id uuid,message text,queued_send jsonb,accepted boolean not null default false,created_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261026110000_agent_session_waiting_on",
		"20261105100000_agent_session_items_rev",
	])
		await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const INTERNAL_TAIL =
	"Inspect its evidence and diff before accepting or publishing the result.";

function internalReport(n: number, long: boolean) {
	return `agent ${n} finished. Its final summary is below:\n\n${"details ".repeat(long ? 200 : 2)}\n\n${INTERNAL_TAIL}`;
}

function item(n: number, shape: number): SessionItem {
	if (shape === 0)
		return { kind: "userMessage", id: `u${n}` as never, text: `ask ${n}` };
	if (shape === 1)
		return { kind: "agentMessage", id: `a${n}` as never, text: `reply ${n}` };
	// An agent's internal report: the view drops it.
	return {
		kind: "agentMessage",
		id: `r${n}` as never,
		text: internalReport(n, shape === 3),
	};
}

async function chat(items: readonly unknown[]) {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,'alice',$2,'codex','chat',$3::jsonb)",
		[id, randomUUID(), JSON.stringify(items)],
	);
	return id;
}

async function storedItems(id: string) {
	const result = await db.query<{ items: unknown }>(
		"select items from agent_session where id=$1",
		[id],
	);
	return childTaskPublicItems(sessionItemsFromUnknown(result.rows[0]?.items));
}

type View = {
	items: readonly SessionItem[];
	turnStatus: "idle";
	workspaceId: null;
	listedModelId: string;
	hasOlderItems?: boolean;
};

/** One delta step as the browser takes it; null when it would read the chat whole. */
async function step(
	id: string,
	held: { view: View; rev: number; count: number },
) {
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: held.rev,
		count: held.count,
	});
	if (!found) throw new Error("chat missing");
	const change = found.fromPosition === null ? null : sessionDeltaChange(found);
	if (found.fromPosition !== null && !change) return null;
	const delta: SessionReadDelta = {
		mode: "delta",
		token: found.token,
		row: {
			turnStatus: "idle",
			workspaceId: null,
			selectedBranch: null,
			listedModelId: "",
		},
		change: change ?? null,
		queued: [],
	};
	const merged = applySessionDelta(
		{
			view: held.view,
			token: { rev: held.rev, count: held.count },
			queuedCount: 0,
			fullAt: 0,
		} as never,
		delta,
		false,
	);
	return merged ? { view: merged.view, ...found.token } : null;
}

it("the token and an unchanged read: nothing changed, nothing sent", async () => {
	const id = await chat([item(0, 0), item(1, 1)]);
	const token = await transcriptTokenForOwner("alice", id);
	expect(token).toEqual({ rev: 0, count: 2 });
	const found = await transcriptDeltaForOwner("alice", id, token!);
	expect(found?.fromPosition).toBeNull();
	expect(found?.tail).toEqual([]);
	expect(await transcriptTokenForOwner("bob", id)).toBeNull();
	expect(await transcriptDeltaForOwner("bob", id, token!)).toBeNull();
});

it("a write that sets items to what it holds bumps the revision and changes no row", async () => {
	const id = await chat([item(0, 0), item(1, 1)]);
	await db.query("update agent_session set items=items where id=$1", [id]);
	const found = await transcriptDeltaForOwner("alice", id, {
		rev: 0,
		count: 2,
	});
	expect(found?.token.rev).toBe(1);
	expect(found?.fromPosition).toBeNull();
});

it("sends the transcript from the first changed item, a shrink included", async () => {
	const id = await chat(Array.from({ length: 6 }, (_, n) => item(n, n % 2)));
	await db.query(
		`update agent_session set items = jsonb_set(items,'{4,text}','"edited"') where id=$1`,
		[id],
	);
	const edited = await transcriptDeltaForOwner("alice", id, {
		rev: 0,
		count: 6,
	});
	expect(edited?.fromPosition).toBe(4);
	expect(edited?.tail).toHaveLength(2);
	await db.query(
		`update agent_session set items = (select jsonb_agg(e order by o) from jsonb_array_elements(items) with ordinality t(e,o) where o <= 3) where id=$1`,
		[id],
	);
	const shrunk = await transcriptDeltaForOwner("alice", id, {
		rev: 1,
		count: 6,
	});
	expect(shrunk?.fromPosition).toBe(3);
	expect(shrunk?.tail).toEqual([]);
	expect(shrunk?.token).toEqual({ rev: 2, count: 3 });
});

it("a delta over many random writes always equals the whole read, or says to read whole", async () => {
	let seed = 12345;
	const random = (n: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % n;
	};
	const start = Array.from({ length: 12 }, (_, n) => item(n, random(4)));
	const id = await chat(start);
	let next = 100;
	let held = {
		view: {
			items: await storedItems(id),
			turnStatus: "idle",
			workspaceId: null,
			listedModelId: "",
		} as View,
		rev: 0,
		count: 12,
	};
	let wholeReads = 0;
	for (let round = 0; round < 120; round++) {
		const kind = random(5);
		if (kind === 0)
			await db.query(
				"update agent_session set items = items || $2::jsonb where id=$1",
				[
					id,
					JSON.stringify([item(next++, random(4)), item(next++, random(4))]),
				],
			);
		else if (kind === 1)
			await db.query(
				`update agent_session set items = jsonb_set(items, array[(jsonb_array_length(items)-1)::text,'id'], to_jsonb($2::text)) where id=$1 and jsonb_array_length(items) > 0`,
				[id, `edited-${next++}`],
			);
		else if (kind === 2)
			await db.query(
				`update agent_session set items = jsonb_set(items, array[($2::int % greatest(jsonb_array_length(items),1))::text,'text'], to_jsonb($3::text)) where id=$1 and jsonb_array_length(items) > 0`,
				[id, random(1000), `changed ${next++}`],
			);
		else if (kind === 3)
			await db.query(
				`update agent_session set items = coalesce((select jsonb_agg(e order by o) from jsonb_array_elements(items) with ordinality t(e,o) where o <= greatest(jsonb_array_length(items)-$2::int,0)),'[]'::jsonb) where id=$1`,
				[id, 1 + random(4)],
			);
		else
			await db.query("update agent_session set items=items where id=$1", [id]);
		const merged = await step(id, held);
		const truth = await storedItems(id);
		if (merged) {
			expect(merged.view.items).toEqual(truth);
			held = {
				view: merged.view as View,
				rev: merged.rev,
				count: merged.count,
			};
		} else {
			wholeReads++;
			const token = await transcriptTokenForOwner("alice", id);
			held = {
				view: { ...held.view, items: truth },
				rev: token!.rev,
				count: token!.count,
			};
		}
	}
	// Most steps are told as deltas; reading whole is the exception.
	expect(wholeReads).toBeLessThan(10);
});
