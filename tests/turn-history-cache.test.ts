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
	expect(history.read("large-turn", "v30")).toEqual({ messages, items: [] });
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
