import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type BackgroundCommandExit,
	hasOpenBackgroundCommand,
	withBackgroundCommandExits,
} from "../src/domain/background-command";
import { jsonbText } from "../src/domain/jsonb";
import type { SessionItem } from "../src/domain/session-item";
import { applyBackgroundCommandExits } from "../src/server/adapters/agent-sessions";

let db: PGlite;
const query = async (sql: string, values: unknown[] = []) => {
	const result = await db.query(sql, values);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
	create table agent_session(id uuid primary key,user_id text not null,turn_status text,items jsonb default '[]',updated_at timestamptz default now());`);
	for (const file of [
		"20261026100000_agent_session_item",
		"20261105100000_agent_session_items_rev",
	])
		await db.exec(await readFile(`supabase/migrations/${file}.sql`, "utf8"));
});

afterAll(async () => {
	await db.close();
});

type Exit = BackgroundCommandExit & { announced: boolean };

const card = (
	id: string,
	commandId: string,
	background: Record<string, unknown> = {},
) =>
	({
		kind: "dynamicToolCall",
		id,
		tool: "bash",
		status: "completed",
		arguments: { command: `run ${commandId}` },
		background: {
			id: commandId,
			label: `run "${commandId}" ü 😀`,
			startedAt: 1_000,
			...background,
		},
	}) as unknown as SessionItem;

const exit = (id: string, overrides: Partial<Exit> = {}): Exit => ({
	id,
	label: `run "${id}" ü 😀`,
	startedAt: 1_000,
	endedAt: 1_000 + 95_000,
	exitCode: 0,
	outputPath: `/tmp/${id}.stdout`,
	lastLines: "done",
	announced: true,
	...overrides,
});

const user = (id: string) =>
	({
		kind: "userMessage",
		id,
		text: 'hello "there" \\ ü',
	}) as unknown as SessionItem;
const notice = (id: string) =>
	({
		kind: "notice",
		id,
		message: "background: something",
		background: true,
	}) as unknown as SessionItem;

async function chat(items: unknown, turnStatus = "completed") {
	const id = randomUUID();
	await db.query(
		"insert into agent_session(id,user_id,turn_status,items) values($1,'alice',$2,$3::jsonb)",
		[id, turnStatus, jsonbText(items)],
	);
	return id;
}

async function stored(id: string) {
	const row = (
		await db.query<{ items: unknown; items_rev: number }>(
			"select items, items_rev from agent_session where id=$1",
			[id],
		)
	).rows[0];
	const mirrored = (
		await db.query<{ items: unknown }>(
			"select coalesce(jsonb_agg(item order by position), '[]'::jsonb) as items from agent_session_item where session_id=$1",
			[id],
		)
	).rows[0].items;
	return { ...row, mirrored };
}

/** The database's write equals withBackgroundCommandExits' result, as stored. */
async function expectSameAsDomain(items: SessionItem[], exits: Exit[]) {
	const id = await chat(items);
	const before = await stored(id);
	const result = await applyBackgroundCommandExits("alice", id, exits);
	const expected = withBackgroundCommandExits(items, exits);
	const after = await stored(id);
	const same = (
		await db.query<{ equal: boolean; text: boolean }>(
			"select items = $2::jsonb as equal, items::text = ($2::jsonb)::text as text from agent_session where id=$1",
			[id, jsonbText(expected)],
		)
	).rows[0];
	expect(same).toEqual({ equal: true, text: true });
	expect(after.items).toEqual(JSON.parse(jsonbText(expected)));
	expect(after.mirrored).toEqual(after.items);
	expect(result).toEqual({
		changed: expected !== items,
		open: hasOpenBackgroundCommand(expected),
	});
	// No write (and no new transcript revision) when nothing changed.
	expect(after.items_rev).toBe(
		Number(before.items_rev) + (expected !== items ? 1 : 0),
	);
	return { expected, after };
}

describe("applyBackgroundCommandExits matches withBackgroundCommandExits", () => {
	it("changes nothing when no exit matches an open card", async () => {
		await expectSameAsDomain(
			[user("u1"), card("c1", "a"), notice("n1")],
			[exit("other")],
		);
		await expectSameAsDomain([], [exit("a")]);
	});

	it("leaves cards that already exited (an exitCode, even null) alone", async () => {
		const { expected } = await expectSameAsDomain(
			[
				user("u1"),
				card("c1", "a", { exitCode: 2, endedAt: 5_000 }),
				card("c2", "b", { exitCode: null }),
				card("c3", "c", { exitCode: "interrupted", endedAt: 9_000 }),
			],
			[exit("a"), exit("b"), exit("c")],
		);
		expect(expected).toHaveLength(4);
	});

	it("records an announced exit and appends its notice line", async () => {
		const { after } = await expectSameAsDomain(
			[user("u1"), card("c1", "a"), user("u2")],
			[exit("a", { exitCode: 3 })],
		);
		expect((after.items as unknown[]).at(-1)).toMatchObject({
			kind: "notice",
			id: "c1:background-exit",
			background: true,
		});
	});

	it("records an exit nobody announces without a notice", async () => {
		await expectSameAsDomain(
			[user("u1"), card("c1", "a")],
			[exit("a", { announced: false, exitCode: "interrupted" })],
		);
	});

	it("takes several exits at once, announced and not, in card order, with other cards still open", async () => {
		const { expected } = await expectSameAsDomain(
			[
				user("u1"),
				card("c1", "b"),
				notice("n1"),
				// A card that already has an end time but no exit code: overwritten.
				card("c2", "a", { endedAt: 1 }),
				card("c3", "still"),
				card("c4", "c"),
				// The same command on a second card: both close.
				card("c5", "b"),
				// Not a command card, though its background id would match.
				{
					kind: "notice",
					id: "n2",
					message: "x",
					background: { id: "a" },
				} as unknown as SessionItem,
				user("u2"),
			],
			[
				exit("a", { exitCode: 1, announced: false }),
				exit("b", { exitCode: 0, endedAt: 4_000_000 }),
				exit("c", { exitCode: "interrupted", announced: true }),
				// The last exit of an id wins.
				exit("c", { exitCode: 137, endedAt: 7_777_777, announced: true }),
				exit("missing"),
			],
		);
		expect(hasOpenBackgroundCommand(expected)).toBe(true);
		expect(expected.filter((item) => item.kind === "notice")).toHaveLength(5);
	});

	it("reports the chat closed once its last open card exits", async () => {
		const { expected } = await expectSameAsDomain(
			[card("c1", "a", { exitCode: 0, endedAt: 2 }), card("c2", "b")],
			[exit("b")],
		);
		expect(hasOpenBackgroundCommand(expected)).toBe(false);
	});
});

describe("applyBackgroundCommandExits guards", () => {
	it("leaves a running turn's timeline alone and reports what it records", async () => {
		const items = [user("u1"), card("c1", "a"), card("c2", "b")];
		const id = await chat(items, "running");
		const before = await stored(id);
		expect(await applyBackgroundCommandExits("alice", id, [exit("a")])).toEqual(
			{ changed: false, open: true },
		);
		expect(await stored(id)).toEqual(before);
	});

	it("reports an idle chat with no open card as closed", async () => {
		const id = await chat([card("c1", "a", { exitCode: 0, endedAt: 2 })]);
		expect(await applyBackgroundCommandExits("alice", id, [exit("a")])).toEqual(
			{ changed: false, open: false },
		);
	});

	it("is null for a chat that is not the user's", async () => {
		const items = [card("c1", "a")];
		const id = await chat(items);
		expect(await applyBackgroundCommandExits("bob", id, [exit("a")])).toBe(
			null,
		);
		expect((await stored(id)).items).toEqual(JSON.parse(jsonbText(items)));
	});
});
