import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	chatWaitingOn,
	PROJECT_COLORS,
	projectColor,
	SIDEBAR_DONE_VISIBLE,
	sidebarStatusGroup,
	sidebarStatusSections,
} from "./sidebar-chats";

const user = (id: string): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: id,
});

describe("what a chat waits on from the user", () => {
	it("is an unanswered card, a paused switch, or a failed turn", () => {
		const question: SessionItem = {
			kind: "userQuestion",
			id: SessionItemId("q"),
			questions: [],
		};
		expect(chatWaitingOn([user("a"), question], "completed")).toBe("question");
		expect(chatWaitingOn([user("a"), question, user("b")], "completed")).toBe(
			null,
		);
		expect(
			chatWaitingOn(
				[
					user("a"),
					{
						kind: "secretRequest",
						id: SessionItemId("s"),
						name: "KEY",
						secretKind: "env" as never,
						reason: "",
					},
				],
				"completed",
			),
		).toBe("secret");
		expect(chatWaitingOn([user("a"), question], "running")).toBe(null);
		expect(chatWaitingOn([user("a")], "failed")).toBe("failed");
		expect(chatWaitingOn([user("a")], "completed")).toBe(null);
	});
});

describe("sidebar status groups", () => {
	it("orders Needs you, Working, Done and folds Done after a few rows", () => {
		expect(sidebarStatusGroup({ running: true, waitingOn: "failed" })).toBe(
			"working",
		);
		expect(sidebarStatusGroup({ running: false, waitingOn: "question" })).toBe(
			"needs-you",
		);
		expect(sidebarStatusGroup({ running: false })).toBe("done");
		const rows = [
			{ id: "w", group: "working" as const },
			{ id: "n", group: "needs-you" as const },
			...Array.from({ length: 11 }, (_, index) => ({
				id: `d${index}`,
				group: "done" as const,
			})),
		];
		const sections = sidebarStatusSections(rows, (row) => row.group);
		expect(sections.needsYou.map((row) => row.id)).toEqual(["n"]);
		expect(sections.working.map((row) => row.id)).toEqual(["w"]);
		expect(sections.done).toHaveLength(SIDEBAR_DONE_VISIBLE);
		expect(sections.doneTotal).toBe(11);
		expect(sections.doneHidden).toBe(11 - SIDEBAR_DONE_VISIBLE);
		expect(
			sidebarStatusSections(rows, (row) => row.group, true).done,
		).toHaveLength(11);
	});
	it("gives each project a stable muted colour", () => {
		const id = "6f1d1c2e-1111-4111-8111-111111111111";
		expect(projectColor(id)).toBe(projectColor(id));
		expect(PROJECT_COLORS).toContain(projectColor(id));
	});
});
