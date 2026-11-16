import { describe, expect, it } from "vitest";
import {
	applyHubSignals,
	applyHubTurnChange,
	type HubChats,
	hubStateMessage,
	hubStatusEntries,
	hubTopic,
	isHubTopic,
	MAX_HUB_NOTE_TOPICS,
	parseHubNote,
	parseHubStateMessage,
	settledHubTurnStatus,
	staleHubChats,
	staleHubSignals,
	userHubEnabledFor,
} from "./user-hub";

describe("userHubEnabledFor", () => {
	it("is off when unset or empty", () => {
		expect(userHubEnabledFor(undefined, "u1")).toBe(false);
		expect(userHubEnabledFor("", "u1")).toBe(false);
		expect(userHubEnabledFor(" , ", "u1")).toBe(false);
	});
	it("takes listed ids, trimmed", () => {
		expect(userHubEnabledFor("u0, u1 ,u2", "u1")).toBe(true);
		expect(userHubEnabledFor("u0,u2", "u1")).toBe(false);
		expect(userHubEnabledFor("u10", "u1")).toBe(false);
	});
	it("takes * for everyone, never an unknown user", () => {
		expect(userHubEnabledFor("*", "anyone")).toBe(true);
		expect(userHubEnabledFor("u0, *", "anyone")).toBe(true);
		expect(userHubEnabledFor("*", undefined)).toBe(false);
		expect(userHubEnabledFor("*", "")).toBe(false);
	});
});

describe("applyHubTurnChange", () => {
	const empty: HubChats = {};
	it("adds a new chat and pushes it", () => {
		const { chats, pushed } = applyHubTurnChange(empty, {
			sessionId: "a",
			turnStatus: "running",
			at: 10,
		});
		expect(chats).toEqual({ a: { turnStatus: "running", updatedAt: 10 } });
		expect(pushed).toEqual({ a: { turnStatus: "running" } });
	});
	it("pushes only the changed entry", () => {
		const start: HubChats = {
			a: { turnStatus: "running", updatedAt: 10 },
			b: { turnStatus: "running", updatedAt: 11 },
		};
		const { chats, pushed } = applyHubTurnChange(start, {
			sessionId: "a",
			turnStatus: "completed",
			at: 20,
		});
		expect(pushed).toEqual({ a: { turnStatus: "completed" } });
		expect(chats.b).toBe(start.b);
		expect(chats.a).toEqual({ turnStatus: "completed", updatedAt: 20 });
	});
	it("stores but does not push the same status again", () => {
		const start: HubChats = { a: { turnStatus: "running", updatedAt: 10 } };
		const { chats, pushed } = applyHubTurnChange(start, {
			sessionId: "a",
			turnStatus: "running",
			at: 15,
		});
		expect(pushed).toBeNull();
		expect(chats.a.updatedAt).toBe(15);
	});
	it("drops a change older than the stored one (out of order calls)", () => {
		const start: HubChats = { a: { turnStatus: "completed", updatedAt: 20 } };
		const result = applyHubTurnChange(start, {
			sessionId: "a",
			turnStatus: "running",
			at: 10,
		});
		expect(result.chats).toBe(start);
		expect(result.pushed).toBeNull();
	});
	it("applies a change at the same instant (the later call wins)", () => {
		const start: HubChats = { a: { turnStatus: "running", updatedAt: 20 } };
		expect(
			applyHubTurnChange(start, {
				sessionId: "a",
				turnStatus: "failed",
				at: 20,
			}).pushed,
		).toEqual({ a: { turnStatus: "failed" } });
	});
});

describe("staleHubChats", () => {
	it("keeps the newest up to the limit", () => {
		const chats: HubChats = {
			a: { turnStatus: "idle", updatedAt: 1 },
			b: { turnStatus: "idle", updatedAt: 3 },
			c: { turnStatus: "idle", updatedAt: 2 },
		};
		expect(staleHubChats(chats, 3)).toEqual([]);
		expect(staleHubChats(chats, 2)).toEqual(["a"]);
		expect(staleHubChats(chats, 1).sort()).toEqual(["a", "c"]);
	});
});

describe("settledHubTurnStatus", () => {
	it("shows completed and failed, idle otherwise", () => {
		expect(settledHubTurnStatus("completed")).toBe("completed");
		expect(settledHubTurnStatus("failed")).toBe("failed");
		expect(settledHubTurnStatus("cancelled")).toBe("idle");
		expect(settledHubTurnStatus("unavailable")).toBe("idle");
	});
});

describe("hub state messages", () => {
	it("round-trips the whole map and changes", () => {
		const entries = hubStatusEntries({
			a: { turnStatus: "running", updatedAt: 1 },
		});
		expect(JSON.parse(hubStateMessage(entries, true))).toEqual({
			type: "state",
			full: true,
			chats: { a: { turnStatus: "running" } },
		});
		expect(parseHubStateMessage(hubStateMessage(entries))).toEqual({
			type: "state",
			chats: { a: { turnStatus: "running" } },
		});
	});
	it("ignores pongs, junk and unknown statuses", () => {
		expect(parseHubStateMessage("pong")).toBeNull();
		expect(parseHubStateMessage("{")).toBeNull();
		expect(parseHubStateMessage(JSON.stringify({ type: "other" }))).toBeNull();
		expect(
			parseHubStateMessage(
				JSON.stringify({
					type: "state",
					chats: { a: { turnStatus: "weird" }, b: { turnStatus: "idle" } },
				}),
			),
		).toEqual({ type: "state", chats: { b: { turnStatus: "idle" } } });
	});
});

describe("hub signals", () => {
	it("stamps each changed topic past its last stamp and pushes it", () => {
		const first = applyHubSignals({}, ["agents:a", "push"], 100);
		expect(first.pushed).toEqual({ "agents:a": 100, push: 100 });
		// Twice in one millisecond still differs, so the tab reads again.
		const again = applyHubSignals(first.signals, ["agents:a"], 100);
		expect(again.pushed).toEqual({ "agents:a": 101 });
		expect(again.signals).toEqual({ "agents:a": 101, push: 100 });
	});
	it("ignores invalid and repeated topics, and caps a note", () => {
		const { pushed } = applyHubSignals(
			{},
			["agents:a", "agents:a", "bad topic", `x:${"y".repeat(101)}`, ""],
			5,
		);
		expect(pushed).toEqual({ "agents:a": 5 });
		const many = Array.from({ length: 30 }, (_, i) => `commands:c${i}`);
		expect(Object.keys(applyHubSignals({}, many, 1).pushed)).toHaveLength(
			MAX_HUB_NOTE_TOPICS,
		);
	});
	it("forgets the oldest topics beyond the limit", () => {
		expect(staleHubSignals({ a: 1, b: 3, c: 2 }, 2)).toEqual(["a"]);
		expect(staleHubSignals({ a: 1 }, 2)).toEqual([]);
	});
	it("names topics by what changed", () => {
		expect(hubTopic.agents("s")).toBe("agents:s");
		expect(hubTopic.commands("s")).toBe("commands:s");
		expect(hubTopic.workspace("p")).toBe("workspace:p");
		expect(hubTopic.fork("s")).toBe("fork:s");
		expect(hubTopic.chat("s")).toBe("chat:s");
		for (const topic of ["agents:s", "push", "workspace:a-b_c"])
			expect(isHubTopic(topic)).toBe(true);
	});
});

describe("state messages with signals and build", () => {
	it("round-trips signals and build on a whole map", () => {
		const text = hubStateMessage({ a: { turnStatus: "running" } }, true, {
			signals: { push: 4 },
			build: "build-2",
		});
		expect(parseHubStateMessage(text)).toEqual({
			type: "state",
			full: true,
			chats: { a: { turnStatus: "running" } },
			signals: { push: 4 },
			build: "build-2",
		});
	});
	it("a signal-only change has no chats an older tab would act on", () => {
		const parsed = parseHubStateMessage(
			hubStateMessage({}, false, { signals: { "commands:a": 9 } }),
		);
		expect(parsed?.chats).toEqual({});
		expect(parsed?.full).toBeUndefined();
	});
	it("an older hub's whole map has no signals (the tab keeps polling)", () => {
		expect(
			parseHubStateMessage(hubStateMessage({}, true))?.signals,
		).toBeUndefined();
	});
	it("drops malformed signals and builds", () => {
		expect(
			parseHubStateMessage(
				JSON.stringify({
					type: "state",
					chats: {},
					signals: { push: "x", "bad topic": 1, "fork:f": 2 },
					build: 7,
				}),
			),
		).toEqual({ type: "state", chats: {}, signals: { "fork:f": 2 } });
	});
});

describe("parseHubNote", () => {
	it("takes a user and valid topics only", () => {
		expect(
			parseHubNote({ userId: "u", topics: ["push", "bad topic"] }),
		).toEqual({ userId: "u", topics: ["push"] });
		expect(parseHubNote({ userId: "u", topics: ["bad topic"] })).toBeNull();
		expect(parseHubNote({ userId: "", topics: ["push"] })).toBeNull();
		expect(parseHubNote({ topics: ["push"] })).toBeNull();
		expect(parseHubNote(null)).toBeNull();
	});
});
