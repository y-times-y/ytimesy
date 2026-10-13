import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { progressIsFresh, progressMatchesTurn } from "./session-progress";

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
