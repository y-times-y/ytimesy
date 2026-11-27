import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { hubStateMessage, parseHubStateMessage } from "#/domain/user-hub";
import {
	followListChanges,
	listQueryKeysToInvalidate,
	RECONNECT_NOTICE_AFTER_MS,
	reconnectingNotice,
	refreshAfterProjectAdded,
	SIDEBAR_REVALIDATE_MS,
} from "./live-freshness";
import { createUserHubStore } from "./user-hub-store";

describe("sidebar revalidation respects the cost cap", () => {
	it("is a long interval (one read a minute or slower) that hidden tabs never run", () => {
		expect(SIDEBAR_REVALIDATE_MS).toBeGreaterThanOrEqual(60_000);
	});
});

describe("refreshAfterProjectAdded", () => {
	it("invalidates the project list and every chat list so the new Super agent row appears", async () => {
		const client = new QueryClient();
		client.setQueryData(["projects"], []);
		client.setQueryData(["agent-sessions", "p1"], []);
		await refreshAfterProjectAdded(client);
		expect(client.getQueryState(["projects"])?.isInvalidated).toBe(true);
		expect(client.getQueryState(["agent-sessions", "p1"])?.isInvalidated).toBe(
			true,
		);
	});
});

describe("reconnectingNotice", () => {
	const open = { open: true, signals: true };
	const closed = { open: false, signals: true };
	it("stays quiet while the socket delivers or never connected", () => {
		expect(
			reconnectingNotice({
				connection: open,
				everOpen: true,
				droppedForMs: 0,
				online: true,
			}),
		).toBeNull();
		expect(
			reconnectingNotice({
				connection: closed,
				everOpen: false,
				droppedForMs: 99_000,
				online: true,
			}),
		).toBeNull();
	});
	it("waits out a brief blip, then says reconnecting", () => {
		expect(
			reconnectingNotice({
				connection: closed,
				everOpen: true,
				droppedForMs: RECONNECT_NOTICE_AFTER_MS - 1,
				online: true,
			}),
		).toBeNull();
		expect(
			reconnectingNotice({
				connection: closed,
				everOpen: true,
				droppedForMs: RECONNECT_NOTICE_AFTER_MS,
				online: true,
			}),
		).toBe("Reconnecting…");
	});
	it("says offline at once when the browser is offline", () => {
		expect(
			reconnectingNotice({
				connection: closed,
				everOpen: true,
				droppedForMs: 0,
				online: false,
			}),
		).toBe("Offline. Showing the last state.");
	});
});

describe("listQueryKeysToInvalidate", () => {
	it("a project's chat list change reads exactly that list (sidebar and Overview share it)", () => {
		expect(
			listQueryKeysToInvalidate({
				kind: "topics",
				topics: new Set(["sessions:p1"]),
			}),
		).toEqual([["agent-sessions", "p1"]]);
	});
	it("a project change reads the project list; an unscoped chat change every chat list", () => {
		expect(
			listQueryKeysToInvalidate({
				kind: "topics",
				topics: new Set(["projects", "sessions"]),
			}),
		).toEqual([["projects"], ["agent-sessions"]]);
	});
	it("a resync (reconnect or a skipped version) reads every list", () => {
		expect(listQueryKeysToInvalidate({ kind: "resync" })).toEqual([
			["projects"],
			["agent-sessions"],
		]);
	});
	it("leaves other topics alone", () => {
		expect(
			listQueryKeysToInvalidate({
				kind: "topics",
				topics: new Set(["push", "chat:a"]),
			}),
		).toEqual([]);
	});
});

describe("a pushed list event reaches the lists (socket message to invalidation)", () => {
	const receive = (
		store: ReturnType<typeof createUserHubStore>,
		text: string,
	) => {
		const message = parseHubStateMessage(text);
		if (!message) throw new Error("not a state message");
		store.receive(message);
	};
	const setup = () => {
		const store = createUserHubStore();
		const client = new QueryClient();
		client.setQueryData(["projects"], []);
		client.setQueryData(["agent-sessions", "p1"], []);
		client.setQueryData(["agent-sessions", "p2"], []);
		followListChanges(store, client);
		receive(store, hubStateMessage({}, true, { signals: {}, seq: 1 }));
		return { store, client };
	};
	const stale = (client: QueryClient, key: string[]) =>
		client.getQueryState(key)?.isInvalidated;
	it("a thread created in p1 makes only p1's list stale, in the same tick", () => {
		const { store, client } = setup();
		receive(
			store,
			hubStateMessage({}, false, { signals: { "sessions:p1": 100 }, seq: 2 }),
		);
		expect(stale(client, ["agent-sessions", "p1"])).toBe(true);
		expect(stale(client, ["agent-sessions", "p2"])).toBe(false);
		expect(stale(client, ["projects"])).toBe(false);
	});
	it("a project added makes the project list and every chat list stale", () => {
		const { store, client } = setup();
		receive(
			store,
			hubStateMessage({}, false, {
				signals: { projects: 5, sessions: 5 },
				seq: 2,
			}),
		);
		expect(stale(client, ["projects"])).toBe(true);
		expect(stale(client, ["agent-sessions", "p2"])).toBe(true);
	});
	it("a skipped event version makes every list stale (gap resync)", () => {
		const { store, client } = setup();
		receive(store, hubStateMessage({}, false, { signals: {}, seq: 4 }));
		expect(stale(client, ["projects"])).toBe(true);
		expect(stale(client, ["agent-sessions", "p1"])).toBe(true);
	});
	it("a reconnect's whole map makes every list stale", () => {
		const { store, client } = setup();
		receive(store, hubStateMessage({}, true, { signals: {}, seq: 9 }));
		expect(stale(client, ["projects"])).toBe(true);
	});
});
