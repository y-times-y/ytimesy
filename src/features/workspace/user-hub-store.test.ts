import { describe, expect, it, vi } from "vitest";
import { hubTopic } from "#/domain/user-hub";
import {
	agentPanelHubTopics,
	anyChatTurn,
	backgroundCommandHubTopics,
	createUserHubStore,
	EMPTY_HUB_MEMORY,
	type HubChange,
	hubChangeConcerns,
	hubChangeFromMessage,
	hubDelivery,
	hubReadDelayMs,
	pollUnlessPushed,
} from "./user-hub-store";

describe("hubDelivery and pollUnlessPushed", () => {
	it("pushes only while the socket delivers and the hub sends signals", () => {
		expect(hubDelivery({ open: true, signals: true })).toBe("push");
		// An older hub (no signals): poll as before.
		expect(hubDelivery({ open: true, signals: false })).toBe("poll");
		// Closed, dropped or not offered: poll as before.
		expect(hubDelivery({ open: false, signals: true })).toBe("poll");
		expect(hubDelivery({ open: false, signals: false })).toBe("poll");
	});
	it("keeps today's interval when polling, none when pushed", () => {
		expect(pollUnlessPushed("poll", 5_000)).toBe(5_000);
		expect(pollUnlessPushed("poll", false)).toBe(false);
		expect(pollUnlessPushed("push", 5_000)).toBe(false);
	});
});

describe("hubChangeFromMessage", () => {
	const first = hubChangeFromMessage(EMPTY_HUB_MEMORY, {
		type: "state",
		full: true,
		chats: { a: { turnStatus: "running" } },
		signals: { "agents:a": 5 },
	});
	it("hears nothing on the first whole map: the page has just read", () => {
		expect(first.change).toBeNull();
		expect(first.memory.wholeMaps).toBe(1);
	});
	it("names the topics a change moved, a chat's turn as chat:<id>", () => {
		const { change } = hubChangeFromMessage(first.memory, {
			type: "state",
			chats: { a: { turnStatus: "completed" } },
			signals: { "agents:a": 6, "workspace:p": 1 },
		});
		expect(change).toEqual({
			kind: "topics",
			topics: new Set(["agents:a", "workspace:p", "chat:a"]),
		});
	});
	it("hears nothing when a message moves nothing it knows", () => {
		const { change } = hubChangeFromMessage(first.memory, {
			type: "state",
			chats: { a: { turnStatus: "running" } },
			signals: { "agents:a": 5 },
		});
		expect(change).toBeNull();
	});
	it("asks one resync on a reconnect's whole map", () => {
		const { change, memory } = hubChangeFromMessage(first.memory, {
			type: "state",
			full: true,
			chats: {},
			signals: {},
		});
		expect(change).toEqual({ kind: "resync" });
		expect(memory.wholeMaps).toBe(2);
		expect(memory.turns).toEqual({});
	});
});

describe("hubChangeConcerns", () => {
	const change: HubChange = {
		kind: "topics",
		topics: new Set(["commands:a", "chat:b"]),
	};
	it("matches listed topics, a test, and every resync", () => {
		expect(hubChangeConcerns(change, ["commands:a"])).toBe(true);
		expect(hubChangeConcerns(change, ["commands:b"])).toBe(false);
		expect(hubChangeConcerns(change, anyChatTurn)).toBe(true);
		expect(
			hubChangeConcerns(
				{ kind: "topics", topics: new Set(["push"]) },
				anyChatTurn,
			),
		).toBe(false);
		expect(hubChangeConcerns({ kind: "resync" }, [])).toBe(true);
	});
});

describe("what the side reads watch", () => {
	it("the agents list: the chat's helpers and each helper's own", () => {
		expect(agentPanelHubTopics(undefined, [{ id: "h" }])).toEqual([]);
		expect(agentPanelHubTopics("root", [{ id: "h" }])).toEqual([
			hubTopic.agents("root"),
			hubTopic.agents("h"),
			hubTopic.chat("h"),
		]);
	});
	it("background commands: each chat's commands and turn", () => {
		expect(backgroundCommandHubTopics(["a", "b"])).toEqual([
			"commands:a",
			"chat:a",
			"commands:b",
			"chat:b",
		]);
	});
	it("spaces reads out by the minimum interval", () => {
		expect(hubReadDelayMs(Number.NEGATIVE_INFINITY, 1_000, 60_000)).toBe(0);
		expect(hubReadDelayMs(1_000, 31_000, 60_000)).toBe(30_000);
		expect(hubReadDelayMs(1_000, 90_000, 60_000)).toBe(0);
	});
});

describe("createUserHubStore", () => {
	it("pushes with a signalling hub, falls back to polling when it drops", () => {
		const store = createUserHubStore();
		const listener = vi.fn();
		store.subscribe(listener);
		expect(hubDelivery(store.connection())).toBe("poll");
		store.setOpen(true);
		store.receive({
			type: "state",
			full: true,
			chats: {},
			signals: {},
			build: "b2",
		});
		expect(hubDelivery(store.connection())).toBe("push");
		expect(store.connection().build).toBe("b2");
		store.setOpen(false);
		expect(hubDelivery(store.connection())).toBe("poll");
		expect(listener).toHaveBeenCalledTimes(3);
	});
	it("keeps polling under an older hub (no signals in its whole map)", () => {
		const store = createUserHubStore();
		store.setOpen(true);
		store.receive({ type: "state", full: true, chats: {} });
		expect(hubDelivery(store.connection())).toBe("poll");
	});
	it("tells watchers each change once, and a reconnect as a resync", () => {
		const store = createUserHubStore();
		const heard: HubChange[] = [];
		const stop = store.watch((change) => heard.push(change));
		store.receive({ type: "state", full: true, chats: {}, signals: {} });
		store.receive({ type: "state", chats: {}, signals: { push: 3 } });
		store.receive({ type: "state", chats: {}, signals: { push: 3 } });
		store.receive({ type: "state", full: true, chats: {}, signals: {} });
		stop();
		store.receive({ type: "state", chats: {}, signals: { push: 4 } });
		expect(heard).toEqual([
			{ kind: "topics", topics: new Set(["push"]) },
			{ kind: "resync" },
		]);
	});
});
