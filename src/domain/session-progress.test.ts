import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { progressIsFresh, progressMatchesTurn } from "./session-progress";

it("treats a null progress ref preserved by hot reload as no live stream", () => {
	expect(progressIsFresh(null, "main", "s", 1000)).toBe(false);
	expect(progressIsFresh(null, "side", "s", 1000)).toBe(false);
});

it("only protects fresh updates belonging to the same session and lane", () => {
	const marks = { main: { sessionId: "s", receivedAt: 1000 } };
	expect(progressIsFresh(marks, "main", "s", 2000)).toBe(true);
	expect(progressIsFresh(marks, "side", "s", 2000)).toBe(false);
	expect(progressIsFresh(marks, "main", "other", 2000)).toBe(false);
	expect(progressIsFresh(marks, "main", "s", 21000)).toBe(false);
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
