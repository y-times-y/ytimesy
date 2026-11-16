import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { replaceSettledTurnItem } from "./api-turns";

const holder = vi.hoisted(() => ({ query: vi.fn(), wake: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));
vi.mock("./conversation-progress-wake", () => ({
	wakeConversationProgress: holder.wake,
}));

let db: PGlite;
const session = randomUUID();
const done = randomUUID();
beforeEach(async () => {
	holder.wake.mockReset();
	db = new PGlite();
	await db.exec(`create table agent_session(id uuid primary key,user_id text,items jsonb not null default '[]',updated_at timestamptz default now());
	 create table api_turn(id uuid primary key,session_id uuid,user_id text,state text,items jsonb not null default '[]',updated_at timestamptz default now());`);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const answer = { kind: "agentMessage", id: "a", text: "Done." };
const opening = {
	kind: "notice",
	id: SessionItemId(`${done}:pull-request`),
	message: "Opening pull request…",
	pullRequest: { state: "opening", since: 1 },
};
const opened = {
	kind: "notice",
	id: SessionItemId(`${done}:pull-request`),
	message: "Opened draft PR #4",
	pullRequest: {
		state: "opened",
		number: 4,
		url: "https://github.com/o/r/pull/4",
		draft: true,
		created: true,
	},
} as const;

async function seed(sessionItems: unknown[], nextTurnItems?: unknown[]) {
	await db.query(
		"insert into agent_session(id,user_id,items) values($1,$2,$3)",
		[session, "alice", JSON.stringify(sessionItems)],
	);
	await db.query(
		"insert into api_turn(id,session_id,user_id,state,items) values($1,$2,'alice','completed',$3)",
		[done, session, JSON.stringify([answer, opening])],
	);
	if (nextTurnItems)
		await db.query(
			"insert into api_turn(id,session_id,user_id,state,items) values($1,$2,'alice','queued',$3)",
			[randomUUID(), session, JSON.stringify(nextTurnItems)],
		);
}
const turn = { id: done, session_id: session, user_id: "alice" };
const items = async (table: string) =>
	(
		await db.query<{ items: unknown[] }>(
			table === "api_turn"
				? "select items from api_turn order by state"
				: "select items from agent_session",
		)
	).rows.map((row) => row.items);

it("replaces the done turn's item in place, keeping a message sent meanwhile", async () => {
	const sent = { kind: "userMessage", id: "u2", text: "Next" };
	await seed([answer, opening, sent], [answer, opening, sent]);
	expect(
		await replaceSettledTurnItem(turn, `${done}:pull-request`, opened as never),
	).toBe(true);
	expect(await items("agent_session")).toEqual([[answer, opened, sent]]);
	// The finished turn and the turn queued since both hold the link.
	expect(await items("api_turn")).toEqual([
		[answer, opened],
		[answer, opened, sent],
	]);
	expect(holder.wake).toHaveBeenCalledOnce();
});

it("removes the item when nothing reached a pull request", async () => {
	await seed([answer, opening]);
	await replaceSettledTurnItem(turn, `${done}:pull-request`, null);
	expect(await items("agent_session")).toEqual([[answer]]);
});

it("changes nothing for a chat that no longer holds the item", async () => {
	await seed([answer]);
	expect(
		await replaceSettledTurnItem(turn, `${done}:pull-request`, opened as never),
	).toBe(false);
	expect(await items("agent_session")).toEqual([[answer]]);
	expect(holder.wake).not.toHaveBeenCalled();
});

it("replaces the item in the chat and leaves a running new-shape turn's marker, bumping its version so its cached history reloads", async () => {
	await seed([answer, opening]);
	const running = randomUUID();
	await db.query(
		"insert into api_turn(id,session_id,user_id,state,items,updated_at) values($1,$2,'alice','running',$3,'2000-01-01')",
		[running, session, JSON.stringify({ from: "u9" })],
	);
	expect(await replaceSettledTurnItem(turn, opening.id, opened)).toBe(true);
	const row = await db.query<{ items: unknown; fresh: boolean }>(
		"select items, updated_at > '2000-01-02' as fresh from api_turn where id=$1",
		[running],
	);
	expect(row.rows[0].items).toEqual({ from: "u9" });
	expect(row.rows[0].fresh).toBe(true);
	expect(await items("agent_session")).toEqual([[answer, opened]]);
});
