import { describe, expect, it } from "vitest";
import {
	CLAUDE_FEED_PROTOCOL,
	CLAUDE_FEED_QUIET_MS,
	CLAUDE_FEED_STALE_MS,
	claudeStepSource,
	feedBatchDecision,
	feedEntriesWithEnds,
	feedWakeAt,
	isStaleFeedRun,
	isUrgentFeedLine,
	presentedFeedGrant,
} from "./claude-feed";

const batch = (from: number, to: number, offsets: number[]) => ({
	from,
	to,
	entries: offsets.map((at): [number, string] => [at, `line ${at}`]),
});

describe("Claude feed contiguity", () => {
	it("accepts a batch only where the stored lines end", () => {
		expect(feedBatchDecision(0, batch(0, 30, [0, 10, 20]))).toEqual({
			kind: "accept",
			receivedTo: 30,
		});
		expect(feedBatchDecision(30, batch(30, 45, [30]))).toEqual({
			kind: "accept",
			receivedTo: 45,
		});
	});
	it("asks for the lines from what it holds after a gap or a partial overlap", () => {
		expect(feedBatchDecision(30, batch(45, 60, [45]))).toEqual({
			kind: "need",
			from: 30,
		});
		expect(feedBatchDecision(30, batch(20, 60, [20, 30, 45]))).toEqual({
			kind: "need",
			from: 30,
		});
	});
	it("acknowledges again a batch it already has (a resend after a lost ack)", () => {
		expect(feedBatchDecision(30, batch(0, 30, [0, 10, 20]))).toEqual({
			kind: "duplicate",
			receivedTo: 30,
		});
		expect(feedBatchDecision(30, batch(20, 30, [20]))).toEqual({
			kind: "duplicate",
			receivedTo: 30,
		});
	});
	it("refuses a malformed batch like a gap", () => {
		// Empty, out of order, starting past `from`, an entry at or past `to`.
		for (const bad of [
			batch(0, 30, []),
			batch(0, 30, [0, 20, 10]),
			batch(0, 30, [5, 10]),
			batch(0, 30, [0, 30]),
		])
			expect(feedBatchDecision(0, bad)).toEqual({ kind: "need", from: 0 });
	});
	it("gives each entry the offset after it", () => {
		expect(feedEntriesWithEnds(batch(0, 30, [0, 10, 20]))).toEqual([
			{ offset: 0, next: 10, line: "line 0" },
			{ offset: 10, next: 20, line: "line 10" },
			{ offset: 20, next: 30, line: "line 20" },
		]);
	});
	it("follows only the turn's newest run", () => {
		expect(isStaleFeedRun(null, 1)).toBe(false);
		expect(isStaleFeedRun(2, 2)).toBe(false);
		expect(isStaleFeedRun(2, 3)).toBe(false);
		expect(isStaleFeedRun(2, 1)).toBe(true);
	});
});

describe("Claude feed step source and wake", () => {
	const state = (lastSeen: number) => ({
		run: 1,
		receivedTo: 10,
		consumedTo: 0,
		lastSeen,
		exitStatus: null,
	});
	it("follows the feed only after a hello from a runner still heard from", () => {
		expect(claudeStepSource(null, 100_000)).toBe("poll");
		// A record holding only a cursor (written by a polling step): no hello.
		expect(claudeStepSource(state(0), 100_000)).toBe("poll");
		expect(claudeStepSource(state(99_000), 100_000)).toBe("feed");
		expect(
			claudeStepSource(state(100_000 - CLAUDE_FEED_STALE_MS), 100_000),
		).toBe("poll");
	});
	it("wakes at once for urgent lines, else when the oldest has waited its cadence", () => {
		const base = { now: 50_000, mode: "quiet" as const, scheduledAt: null };
		expect(feedWakeAt({ ...base, urgent: true, pendingSince: 49_000 })).toBe(
			50_000,
		);
		expect(feedWakeAt({ ...base, urgent: false, pendingSince: 48_000 })).toBe(
			48_000 + CLAUDE_FEED_QUIET_MS,
		);
		expect(
			feedWakeAt({
				...base,
				mode: "live",
				urgent: false,
				pendingSince: 30_000,
			}),
		).toBe(50_000);
		// Never later than the wake already set (the lease-renewing pause).
		expect(
			feedWakeAt({
				...base,
				urgent: false,
				pendingSince: 50_000,
				scheduledAt: 55_000,
			}),
		).toBe(55_000);
	});
	it("treats the run's start, a tool call and its result as urgent", () => {
		expect(isUrgentFeedLine('{"type":"system","subtype":"init"}')).toBe(true);
		expect(isUrgentFeedLine('{"type":"result","subtype":"success"}')).toBe(
			true,
		);
		expect(
			isUrgentFeedLine(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "tool_use", id: "t" }] },
				}),
			),
		).toBe(true);
		expect(
			isUrgentFeedLine(
				JSON.stringify({
					type: "assistant",
					message: { content: [{ type: "text", text: "hi" }] },
				}),
			),
		).toBe(false);
		expect(isUrgentFeedLine("not json")).toBe(false);
	});
	it("reads the grant from a bearer or the feed's second subprotocol", () => {
		expect(
			presentedFeedGrant(new Headers({ authorization: "Bearer ytcc1.a.b" })),
		).toBe("ytcc1.a.b");
		expect(
			presentedFeedGrant(
				new Headers({
					"sec-websocket-protocol": `${CLAUDE_FEED_PROTOCOL}, ytcc1.a.b`,
				}),
			),
		).toBe("ytcc1.a.b");
		expect(
			presentedFeedGrant(
				new Headers({ "sec-websocket-protocol": "other, ytcc1.a.b" }),
			),
		).toBeNull();
	});
});
