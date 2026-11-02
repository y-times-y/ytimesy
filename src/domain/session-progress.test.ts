import { describe, expect, it } from "vitest";
import {
	childTaskEventQueueText,
	childTaskPublicItems,
} from "./child-task-activity";
import { SessionItemId } from "./ids";
import {
	HELD_DELIVERY_POLL_MS,
	LIVE_STREAM_RECONCILE_MS,
	progressIsFresh,
	progressMatchesTurn,
	progressRevivesStoppedTurn,
	progressStreamWanted,
	SEND_TIMEOUT_MESSAGE,
	sessionReadInterval,
	withinTimeout,
} from "./session-progress";

it("treats a missing progress mark as no live stream", () => {
	expect(progressIsFresh(null, "s", 1000)).toBe(false);
});

it("only protects fresh updates belonging to the same session", () => {
	const mark = { sessionId: "s", receivedAt: 1000 };
	expect(progressIsFresh(mark, "s", 2000)).toBe(true);
	expect(progressIsFresh(mark, "other", 2000)).toBe(false);
	expect(progressIsFresh(mark, "s", 21000)).toBe(false);
});

const user = {
	kind: "userMessage" as const,
	id: SessionItemId("u"),
	text: "hello",
};
it("rejects a previous turn even when the user repeats the same prompt", () => {
	expect(progressMatchesTurn([user, user], [user])).toBe(false);
	expect(progressMatchesTurn([user], [user])).toBe(true);
});

it("accepts a server-started wake-up turn after the open chat's last message", () => {
	const wake = {
		kind: "userMessage" as const,
		id: SessionItemId("wake"),
		text: "\u2063ytimesy-child-event:e1",
	};
	expect(progressMatchesTurn([user], [user, wake])).toBe(true);
	// A snapshot from before the open chat's own send still never erases it.
	const sent = { ...user, id: SessionItemId("sent"), text: "next" };
	expect(progressMatchesTurn([user, sent], [user, wake])).toBe(false);
});

describe("progressStreamWanted", () => {
	it("listens while the turn runs, helpers work, or a wake-up may follow", () => {
		const idle = {
			turnRunning: false,
			helpersWorking: false,
			watchingForWake: false,
		};
		expect(progressStreamWanted(idle)).toBe(false);
		expect(progressStreamWanted({ ...idle, turnRunning: true })).toBe(true);
		expect(progressStreamWanted({ ...idle, helpersWorking: true })).toBe(true);
		expect(progressStreamWanted({ ...idle, watchingForWake: true })).toBe(true);
	});
});

describe("progressRevivesStoppedTurn", () => {
	it("ignores a stale running snapshot of a stopped turn, not a wake-up after it", () => {
		const wake = {
			kind: "userMessage" as const,
			id: SessionItemId("wake"),
			text: "\u2063ytimesy-child-event:e1",
		};
		const input = {
			stopRequested: true,
			current: [user],
			next: [user],
			nextStatus: "running" as const,
		};
		expect(progressRevivesStoppedTurn(input)).toBe(true);
		expect(progressRevivesStoppedTurn({ ...input, nextStatus: "idle" })).toBe(
			false,
		);
		expect(progressRevivesStoppedTurn({ ...input, next: [user, wake] })).toBe(
			false,
		);
		expect(progressRevivesStoppedTurn({ ...input, stopRequested: false })).toBe(
			false,
		);
	});
	it("lets a wake-up turn through as the browser gets it (a silent start)", () => {
		const next = childTaskPublicItems([
			user,
			{
				kind: "userMessage",
				id: SessionItemId("wake"),
				text: childTaskEventQueueText("e1"),
				timing: { startedAt: 1 },
			},
		]);
		expect(
			next.some((item) => item.kind === "userMessage" && item.id === "wake"),
		).toBe(false);
		expect(
			progressRevivesStoppedTurn({
				stopRequested: true,
				current: [user],
				next,
				nextStatus: "running",
			}),
		).toBe(false);
	});
});

describe("sessionReadInterval", () => {
	it("reads an idle chat while its held message is being delivered, and only then", () => {
		expect(
			sessionReadInterval({
				polling: false,
				streamOpen: false,
				pollMs: 700,
				awaitingHeldDelivery: true,
			}),
		).toBe(HELD_DELIVERY_POLL_MS);
		expect(
			sessionReadInterval({
				polling: false,
				streamOpen: false,
				pollMs: 700,
				awaitingHeldDelivery: false,
			}),
		).toBe(false);
		// Its turn runs: the running chat's own reads take over.
		expect(
			sessionReadInterval({
				polling: true,
				streamOpen: true,
				pollMs: 700,
				awaitingHeldDelivery: true,
			}),
		).toBe(LIVE_STREAM_RECONCILE_MS);
	});

	it("polls a running chat quickly only while no progress stream is open", () => {
		expect(
			sessionReadInterval({ polling: true, streamOpen: false, pollMs: 700 }),
		).toBe(700);
		expect(
			sessionReadInterval({ polling: true, streamOpen: true, pollMs: 700 }),
		).toBe(LIVE_STREAM_RECONCILE_MS);
		expect(
			sessionReadInterval({ polling: false, streamOpen: false, pollMs: 700 }),
		).toBe(false);
	});
});

describe("withinTimeout", () => {
	it("passes a settled result through and reports one that hangs", async () => {
		expect(await withinTimeout(Promise.resolve("sent"), 50, "slow")).toBe(
			"sent",
		);
		await expect(
			withinTimeout(Promise.reject(new Error("refused")), 50, "slow"),
		).rejects.toThrow("refused");
		await expect(
			withinTimeout(new Promise(() => {}), 10, SEND_TIMEOUT_MESSAGE),
		).rejects.toThrow(SEND_TIMEOUT_MESSAGE);
	});
});
