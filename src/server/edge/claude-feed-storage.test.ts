import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SqliteClaudeFeed } from "./claude-feed-storage";

/** Durable Object SQL over node:sqlite: just the exec/toArray the store uses. */
function sqlStorage() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	} as unknown as SqlStorage;
}

const TURN = "22222222-2222-4222-8222-222222222222";
const lines = (from: number, to: number, offsets: number[]) => ({
	type: "lines" as const,
	from,
	to,
	entries: offsets.map((at): [number, string] => [at, `{"at":${at}}`]),
});

describe("Claude feed storage", () => {
	it("stores lines in order, ignores a resend and asks for a gap", () => {
		const feed = new SqliteClaudeFeed(sqlStorage());
		expect(feed.hello(TURN, 1, 1_000)).toBe(0);
		expect(feed.accept(TURN, 1, lines(0, 20, [0, 10]), 1_001)).toEqual({
			kind: "accept",
			receivedTo: 20,
		});
		expect(feed.accept(TURN, 1, lines(0, 20, [0, 10]), 1_002)).toEqual({
			kind: "duplicate",
			receivedTo: 20,
		});
		expect(feed.accept(TURN, 1, lines(30, 40, [30]), 1_003)).toEqual({
			kind: "need",
			from: 20,
		});
		expect(feed.lines(TURN, 1, 0, 10)).toEqual([
			{ offset: 0, next: 10, line: '{"at":0}' },
			{ offset: 10, next: 20, line: '{"at":10}' },
		]);
		expect(feed.state(TURN, 1)).toMatchObject({
			receivedTo: 20,
			lastSeen: 1_003,
		});
		// A reconnect resumes from what is held.
		expect(feed.hello(TURN, 1, 2_000)).toBe(20);
	});
	it("keeps only the current run and refuses an older one", () => {
		const feed = new SqliteClaudeFeed(sqlStorage());
		feed.hello(TURN, 1, 1_000);
		feed.accept(TURN, 1, lines(0, 10, [0]), 1_000);
		expect(feed.hello(TURN, 2, 2_000)).toBe(0);
		expect(feed.state(TURN, 1)).toBeNull();
		expect(feed.lines(TURN, 1, 0, 10)).toEqual([]);
		expect(feed.hello(TURN, 1, 3_000)).toBeNull();
		expect(feed.accept(TURN, 1, lines(0, 10, [0]), 3_000)).toBeNull();
	});
	it("keeps a polling step's cursor without a hello, and drops read lines on commit", () => {
		const feed = new SqliteClaudeFeed(sqlStorage());
		feed.commitConsumed(TURN, 1, 15);
		expect(feed.state(TURN, 1)).toMatchObject({
			consumedTo: 15,
			lastSeen: 0,
		});
		feed.hello(TURN, 1, 1_000);
		feed.accept(TURN, 1, lines(0, 30, [0, 10, 20]), 1_000);
		feed.commitConsumed(TURN, 1, 20);
		expect(feed.lines(TURN, 1, 0, 10).map((line) => line.offset)).toEqual([20]);
		// Never moves back.
		feed.commitConsumed(TURN, 1, 10);
		expect(feed.state(TURN, 1)?.consumedTo).toBe(20);
		feed.exit(TURN, 1, "0", 2_000);
		expect(feed.state(TURN, 1)?.exitStatus).toBe("0");
		feed.clearTurn(TURN);
		expect(feed.state(TURN, 1)).toBeNull();
	});
});
