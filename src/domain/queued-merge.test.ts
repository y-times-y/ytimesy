import { expect, it } from "vitest";
import { steeringOrigin, steeringTexts } from "./agent-steering";
import { SessionItemId } from "./ids";
import { MERGED_QUEUE_NOTE, mergedQueuedTurn } from "./queued-merge";
import {
	type SessionItem,
	sessionItemsQueuedWithUser,
	sessionItemsWithMergedUsers,
	type UserMessageItem,
} from "./session-item";

const user = (id: string, text: string): UserMessageItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text,
});

it("numbers the messages in order for the model and leaves the last as the send", () => {
	const parts = ["a", "b", "c"].map((id) => ({
		item: user(id, id.toUpperCase()),
		message: `${id.toUpperCase()} (note)`,
	}));
	const merged = mergedQueuedTurn(parts);
	expect(merged?.items.map((item) => item.id)).toEqual(["a", "b"]);
	expect(merged?.modelText).toBe(
		`${MERGED_QUEUE_NOTE(3)}\n\nMessage 1 of 3:\nA (note)\n\nMessage 2 of 3:\nB (note)\n\nMessage 3 of 3:\nC (note)`,
	);
});

it("does not merge a single message", () => {
	expect(
		mergedQueuedTurn([{ item: user("a", "A"), message: "A" }]),
	).toBeUndefined();
	expect(mergedQueuedTurn([])).toBeUndefined();
});

it("adds each merged bubble before the send's, once, even on a replay", () => {
	const earlier = [user("a", "A"), user("b", "B")];
	const once = sessionItemsQueuedWithUser(
		sessionItemsWithMergedUsers([], earlier),
		"C",
		"c",
	);
	expect(once.map((item) => item.id)).toEqual(["a", "b", "c"]);
	const again = sessionItemsQueuedWithUser(
		sessionItemsWithMergedUsers(once, earlier),
		"C",
		"c",
	);
	expect(again.map((item: SessionItem) => item.id)).toEqual(["a", "b", "c"]);
});

it("tells a sender's steering messages apart from the person's and from other senders'", () => {
	const text = (title: string, id: string) =>
		steeringTexts({
			sender: { kind: "parent", title, id },
			message: "hi",
			messageId: "m",
		}).text;
	expect(steeringOrigin("Just a message")).toBeNull();
	expect(steeringOrigin(text("Lead", "1"))).toBe("Lead (1)");
	expect(steeringOrigin(text("Lead", "1"))).not.toBe(
		steeringOrigin(text("Other", "2")),
	);
});
