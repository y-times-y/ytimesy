import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionItem } from "#/domain/session-item";
import {
	latestTranscriptPage,
	olderTranscriptPage,
} from "#/domain/transcript-page";
import {
	agentSessionPageForOwner,
	listSidebarAgentSessions,
} from "./agent-sessions";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

let db: PGlite;
const project = randomUUID();
beforeEach(async () => {
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,project_id uuid,workspace_id uuid,harness text,provider_ref text,parent_session_id uuid,title text,briefing text,items jsonb not null default '[]',listed_model_id text,turn_status text default 'idle',status text default 'ready',task_prompt text,task_state text,task_placement text,task_access text,task_summary text,task_review_state text,task_branch text,selected_branch text,base_branch text,working_branch text,agent_role text,agent_budget jsonb,agent_fork jsonb,agent_steps int not null default 0,created_at timestamptz default now(),updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,state text,created_at timestamptz default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

/** Turn `n`: the user's message, some work, the reply; every third is a wake-up turn. */
function turnItems(n: number): SessionItem[] {
	const start: SessionItem =
		n % 3 === 2
			? { kind: "notice", id: `t${n}` as never, message: "", wake: true }
			: { kind: "userMessage", id: `t${n}` as never, text: `ask ${n}` };
	return [
		start,
		{
			kind: "commandExecution",
			id: `t${n}-cmd` as never,
			command: "ls",
			cwd: null,
			status: "completed",
			output: "",
			exitCode: 0,
		},
		{ kind: "agentMessage", id: `t${n}-reply` as never, text: `reply ${n}` },
	];
}

async function chat(items: readonly unknown[], user = "alice") {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,project_id,harness,title,items) values($1,$2,$3,'codex','chat',$4::jsonb)",
		[id, user, project, JSON.stringify(items)],
	);
	return id;
}

const ids = (items: unknown) =>
	(items as SessionItem[]).map((item) => item.id as string);

it("reads the last turns whole, then each page before the oldest item read, until none is older", async () => {
	const items = Array.from({ length: 7 }, (_, n) => turnItems(n)).flat();
	const id = await chat(items);

	const latest = await agentSessionPageForOwner("alice", id, { turns: 3 });
	expect(ids(latest?.items)).toEqual(ids(items.slice(12)));
	expect(latest).toMatchObject({ hasOlderItems: true, pageFound: true });

	const second = await agentSessionPageForOwner("alice", id, {
		turns: 3,
		beforeId: "t4",
	});
	expect(ids(second?.items)).toEqual(ids(items.slice(3, 12)));
	expect(second?.hasOlderItems).toBe(true);

	const last = await agentSessionPageForOwner("alice", id, {
		turns: 3,
		beforeId: "t1",
	});
	expect(ids(last?.items)).toEqual(ids(items.slice(0, 3)));
	expect(last?.hasOlderItems).toBe(false);
});

it("matches the page the browser's own code cuts, for every cursor", async () => {
	const items = [
		// Items before the first turn start belong to the oldest page.
		{ kind: "agentMessage", id: "lead", text: "hello" },
		...Array.from({ length: 10 }, (_, n) => turnItems(n)).flat(),
	] as SessionItem[];
	const id = await chat(items);
	for (const turns of [1, 2, 4, 30]) {
		const latest = await agentSessionPageForOwner("alice", id, { turns });
		const expected = latestTranscriptPage(items, turns);
		expect(ids(latest?.items)).toEqual(ids(expected.items));
		expect(latest?.hasOlderItems).toBe(expected.hasOlderItems);
		for (const item of items) {
			const page = await agentSessionPageForOwner("alice", id, {
				turns,
				beforeId: item.id,
			});
			const cut = olderTranscriptPage(items, item.id, turns);
			expect(ids(page?.items)).toEqual(ids(cut?.items));
			expect(page?.hasOlderItems).toBe(cut?.hasOlderItems);
		}
	}
});

it("reads an empty chat, a cursor the transcript lost, and nothing of another user's chat", async () => {
	const empty = await chat([]);
	expect(
		await agentSessionPageForOwner("alice", empty, { turns: 30 }),
	).toMatchObject({ items: [], hasOlderItems: false, pageFound: true });

	const id = await chat(turnItems(0));
	expect(
		await agentSessionPageForOwner("alice", id, {
			turns: 30,
			beforeId: "gone",
		}),
	).toMatchObject({ items: [], hasOlderItems: false, pageFound: false });
	expect(await agentSessionPageForOwner("bob", id, { turns: 30 })).toBeNull();
});

it("lists each chat with only its last turn, enough to say what it waits on", async () => {
	await chat([
		...turnItems(0),
		{ kind: "userMessage", id: "q", text: "pick" },
		{ kind: "userQuestion", id: "ask", questions: [] },
	]);
	const [listed] = await listSidebarAgentSessions("alice", project);
	// The sidebar reads only item kinds, not bodies or ids.
	expect((listed?.items as { kind: string }[]).map((item) => item.kind)).toEqual([
		"userMessage",
		"userQuestion",
	]);
});
