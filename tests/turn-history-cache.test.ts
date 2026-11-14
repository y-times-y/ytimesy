import { expect, it, vi } from "vitest";
import { TurnHistoryCache } from "../src/server/edge/turn-history-cache";
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
