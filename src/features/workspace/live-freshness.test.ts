import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
	listQueryKeysToInvalidate,
	RECONNECT_NOTICE_AFTER_MS,
	reconnectingNotice,
	refreshAfterProjectAdded,
	SIDEBAR_REVALIDATE_MS,
} from "./live-freshness";

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
