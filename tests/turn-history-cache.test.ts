import { expect, it } from "vitest";
import { TurnHistoryCache } from "../src/server/edge/turn-history-cache";
import { durableObjectState } from "./support/durable-object-state";

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

it("drops a partial write it cannot complete and clears finished turns", () => {
	const history = cache();
	history.write("t", "v1", { items: [] });
	expect(history.read("t", "v1")).toBeNull();
	history.write("t", "v1", { messages, items: [] });
	history.clear();
	expect(history.read("t", "v1")).toBeNull();
});
