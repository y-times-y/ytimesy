import { expect, it, vi } from "vitest";
import {
	seededTranscript,
	TurnHistoryCache,
} from "../src/server/edge/turn-history-cache";
import { durableObjectState } from "./support/durable-object-state";

it("checks message existence without reconstructing large history for each progress delta", () => {
	const sql = durableObjectState().ctx.storage.sql;
	const exec = vi.spyOn(sql, "exec");
	const history = new TurnHistoryCache(sql as never);
	history.write("large-turn", "v1", { messages, items: [] });
	exec.mockClear();
	for (let i = 2; i <= 30; i++)
		history.write("large-turn", `v${i}`, { items: [] });
	expect(
		exec.mock.calls.some(([query]) => query.startsWith("select data")),
	).toBe(false);
	expect(
		exec.mock.calls.filter(([query]) => /^(insert|update|delete)/i.test(query)),
	).toEqual([]);
	expect(history.read("large-turn", "v30")).toEqual({ messages, items: [] });
});

it("reads only independently parseable pages at the active user message, not old transcript chunks", () => {
	const state = durableObjectState();
	const sql = state.ctx.storage.sql;
	const history = new TurnHistoryCache(sql as never);
	const archived = Array.from({ length: 160 }, (_, index) =>
		item(`archived-${index}`, "old bytes ".repeat(4_000)),
	);
	const active = [
		{ kind: "userMessage", id: "current-77", text: "continue" },
		item("current-answer"),
	] as never;
	history.write("turn", "v1", {
		messages: [{ role: "user", content: "continue" }],
		items: [...archived, ...active],
	});
	const parse = vi.spyOn(JSON, "parse");
	try {
		expect(history.readActive("turn", "v1", "current-77")?.items).toEqual(
			active,
		);
		expect(
			parse.mock.calls.reduce((bytes, [text]) => bytes + text.length, 0),
		).toBeLessThan(501_000);
	} finally {
		parse.mockRestore();
	}
	// A cache created before the page index is a miss, never a whole-history parse.
	sql.exec("delete from turn_item_anchor");
	expect(history.readActive("turn", "v1", "current-77")).toBeNull();
});

it("keeps a silent wake as an active-turn anchor after internal user messages are hidden", () => {
	const history = cache();
	const wake = {
		kind: "notice",
		id: "wake-now",
		wake: true,
		message: "",
	} as never;
	history.write("turn", "v1", {
		messages: [],
		items: [item("older"), wake, item("new-result")],
	});
	expect(history.readActive("turn", "v1", "wake-now")?.items).toEqual([
		wake,
		item("new-result"),
	]);
});

it("stream progress is a cache miss after restart, and the next checkpoint persists it", () => {
	const state = durableObjectState();
	const sql = state.ctx.storage.sql;
	const history = new TurnHistoryCache(sql as never);
	const prompt = { kind: "userMessage", id: "current", text: "work" } as never;
	const context = [{ role: "user" as const, content: "work" }];
	history.write("turn", "v1", { messages: context, items: [prompt] });
	const streamed = [prompt, item("answer", "partial answer")];
	history.write("turn", "v2", { items: streamed }, "v1", "2");
	streamed[1] = item("answer", "not committed yet");
	expect(history.readActive("turn", "v2", "current")?.items[1]).toEqual(
		item("answer", "partial answer"),
	);
	const restarted = new TurnHistoryCache(sql as never);
	// The database reports v2, not the durable cache's v1: the executor must reload Postgres.
	expect(restarted.readActive("turn", "v2", "current")).toBeNull();
	const checkpoint = [prompt, item("answer", "checkpointed answer")];
	history.write(
		"turn",
		"v3",
		{ messages: context, items: checkpoint },
		"v2",
		"3",
	);
	expect(
		new TurnHistoryCache(sql as never).readActive("turn", "v3", "current")
			?.items,
	).toEqual(checkpoint);
});

it("invalidates the previous version before a failed page write, so partial cache data cannot be served", () => {
	const history = cache();
	history.write("turn", "v1", { messages: [], items: [] });
	expect(() =>
		history.write("turn", "v2", {
			messages: [],
			items: [item("too-large", "z".repeat(600_000))],
		}),
	).toThrow("page size");
	expect(history.read("turn", "v1")).toBeNull();
	expect(history.read("turn", "v2")).toBeNull();
});

function cache() {
	return new TurnHistoryCache(durableObjectState().ctx.storage.sql as never);
}
const messages = [{ role: "user" as const, content: "x".repeat(1_200_000) }];

it("serves only the exact version Postgres reported, across chunked values", () => {
	const history = cache();
	history.write("t", "v1", { messages, items: [] });
	expect(history.read("t", "v1")).toEqual({ messages, items: [] });
	expect(history.read("t", "v2")).toBeNull();
});

it("applies an items-only write on top of the cached messages", () => {
	const history = cache();
	history.write("t", "v1", { messages, items: [] });
	const items = [{ kind: "error", id: "e", message: "m" }] as never;
	history.write("t", "v2", { items });
	expect(history.read("t", "v2")).toEqual({ messages, items });
	expect(history.read("t", "v1")).toBeNull();
});

it("moves to a new version only from the version it holds", () => {
	const history = cache();
	history.write("t", "v1", { messages, items: [] });
	const items = [{ kind: "error", id: "e", message: "m" }] as never;
	history.write("t", "v2", { items }, "v1");
	expect(history.read("t", "v2")).toEqual({ messages, items });
	// Someone else wrote v3 after v2; this step's write on top of it is v4.
	history.write("t", "v4", { messages, items }, "v3");
	expect(history.read("t", "v4")).toBeNull();
	expect(history.read("t", "v2")).toBeNull();
});

it("drops a partial write it cannot complete and clears finished turns", () => {
	const history = cache();
	history.write("t", "v1", { items: [] });
	expect(history.read("t", "v1")).toBeNull();
	history.write("t", "v1", { messages, items: [] });
	history.clear();
	expect(history.read("t", "v1")).toBeNull();
});

const item = (id: string, text = id) =>
	({ kind: "agentMessage", id, text }) as never;

it("keeps the last turn's transcript at its revision when the turn ends, and nothing else", () => {
	const history = cache();
	history.write("t1", "v1", { messages, items: [item("a")] }, undefined, "5");
	history.write("t1", "v2", { items: [item("a"), item("b")] }, "v1", "6");
	history.keepChatCopy();
	expect(history.chatCopy()).toEqual({
		itemsRev: "6",
		items: [item("a"), item("b")],
	});
	// The turn's own copy is gone: the next turn never reads it as its history.
	expect(history.read("t1", "v2")).toBeNull();
	// The next turn's copy, once it ends, replaces it.
	history.write(
		"t2",
		"w1",
		{ messages, items: [item("a"), item("b"), item("c")] },
		undefined,
		"9",
	);
	history.keepChatCopy();
	expect(history.chatCopy()?.itemsRev).toBe("9");
	expect(history.chatCopy()?.items).toHaveLength(3);
});

it("keeps no copy whose revision is unknown, and a purge drops the copy", () => {
	const history = cache();
	history.write("t1", "v1", { messages, items: [item("a")] });
	history.keepChatCopy();
	expect(history.chatCopy()).toBeNull();
	history.write("t2", "v1", { messages, items: [item("a")] }, undefined, "3");
	history.keepChatCopy();
	expect(history.chatCopy()).not.toBeNull();
	history.clear();
	expect(history.chatCopy()).toBeNull();
});

it("rebuilds the transcript from the copy and only the rows written since", () => {
	const copy = [item("a"), item("b"), item("c")];
	// Appended rows (a new user message), one edited row, nothing else read.
	expect(
		seededTranscript(copy, 5, [
			{ position: 1, item: item("b", "edited") },
			{ position: 3, item: item("d") },
			{ position: 4, item: item("e") },
		]),
	).toEqual([item("a"), item("b", "edited"), item("c"), item("d"), item("e")]);
	// The transcript shrank (a recovery rewrote it shorter).
	expect(seededTranscript(copy, 2, [])).toEqual([item("a"), item("b")]);
	// A position no row and no copy covers: read the whole transcript instead.
	expect(
		seededTranscript(copy, 5, [{ position: 4, item: item("e") }]),
	).toBeNull();
	expect(
		seededTranscript(copy, 3, [{ position: 7, item: item("x") }]),
	).toBeNull();
});
