import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import {
	LIVE_STREAM_RECONCILE_MS,
	progressIsFresh,
	progressMatchesTurn,
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

describe("sessionReadInterval", () => {
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
