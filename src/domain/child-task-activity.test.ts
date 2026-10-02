import { expect, it } from "vitest";
import {
	childTaskEventQueueText,
	childTaskPromptId,
	childTaskPublicItems,
} from "./child-task-activity";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";

it("hides internal wakeups and historical forwarded results without hiding ordinary chat", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("ask"),
			text: "Fix the branch picker",
		},
		{
			kind: "userMessage",
			id: SessionItemId("event"),
			text: childTaskEventQueueText("1"),
		},
		{
			kind: "userMessage",
			id: SessionItemId("native"),
			text: `${childTaskEventQueueText("1")}\nEvidence`,
		},
		{
			kind: "userMessage",
			id: SessionItemId("legacy"),
			text: "Fix branch names finished. Its final summary is below:\n\nEvidence\n\nInspect its evidence and diff before accepting or publishing the result.",
		},
		{
			kind: "agentMessage",
			id: SessionItemId("answer"),
			text: "I reviewed the implementation and its tests.",
		},
	];
	expect(childTaskPublicItems(items).map((item) => item.id)).toEqual([
		"ask",
		"answer",
	]);
});

it("keeps a child attached to the prompt that started it after a follow-up", () => {
	const items: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("first"),
			text: "Fix it",
			timing: { startedAt: 1000 },
		},
		{
			kind: "userMessage",
			id: SessionItemId("followup"),
			text: "Another task",
			timing: { startedAt: 3000 },
		},
	];
	expect(
		childTaskPromptId({ createdAt: new Date(2000).toISOString() }, items),
	).toBe("first");
});
