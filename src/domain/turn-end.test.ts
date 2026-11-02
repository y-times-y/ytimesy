import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import { progressRevivesStoppedTurn } from "./session-progress";
import {
	STOPPED_NOTICE,
	sessionStoppedByUser,
	settledTurnItems,
	withStoppedNotice,
} from "./turn-end";

const message = (
	id: string,
	timing: { startedAt: number; completedAt?: number },
	queued = false,
): SessionItem => ({
	kind: "userMessage",
	id: SessionItemId(id),
	text: id,
	timing,
	...(queued ? { queued: true as const } : {}),
});

describe("settledTurnItems", () => {
	it("records the turn's end on its messages, not on earlier turns or queued ones", () => {
		const items = settledTurnItems(
			[
				message("old", { startedAt: 1_000, completedAt: 2_000 }),
				message("ask", { startedAt: 3_000 }),
				{ kind: "agentMessage", id: SessionItemId("a"), text: "done" },
				message("next", { startedAt: 4_000 }, true),
			],
			9_000,
		);
		const timing = (id: string) => {
			const item = items.find((entry) => entry.id === id);
			return item?.kind === "userMessage" ? item.timing : undefined;
		};
		expect(timing("old")).toEqual({ startedAt: 1_000, completedAt: 2_000 });
		expect(timing("ask")).toEqual({ startedAt: 3_000, completedAt: 9_000 });
		expect(timing("next")).toEqual({ startedAt: 4_000 });
	});
	it("leaves messages from before ends were recorded alone", () => {
		const day = 24 * 60 * 60 * 1000;
		const items = settledTurnItems(
			[message("legacy", { startedAt: 0 })],
			day + 1,
		);
		expect(items[0]).toEqual(message("legacy", { startedAt: 0 }));
	});
});

describe("withStoppedNotice", () => {
	it("closes a stopped turn with one Stopped notice", () => {
		const once = withStoppedNotice([message("ask", { startedAt: 1 })], "t1");
		expect(once.at(-1)).toEqual({
			kind: "notice",
			id: "t1:stopped",
			message: STOPPED_NOTICE,
			stopped: true,
		});
		expect(withStoppedNotice(once, "t1")).toHaveLength(2);
	});
});

describe("sessionStoppedByUser", () => {
	const running = {
		turnStatus: "running" as const,
		items: [
			message("ask", { startedAt: 3_000 }),
			{
				kind: "reasoning",
				id: SessionItemId("t:r"),
				summaries: ["thinking"],
			},
			{
				kind: "agentMessage",
				id: SessionItemId("t:a"),
				text: "Half an answ",
				streaming: true,
			},
			message("later", { startedAt: 4_000 }, true),
		] satisfies SessionItem[],
	};

	it("shows the chat stopped at once, keeping the partial answer and the waiting message", () => {
		const stopped = sessionStoppedByUser(running, 5_000);
		expect(stopped.turnStatus).toBe("idle");
		expect(stopped.items.map((item) => item.kind)).toEqual([
			"userMessage",
			"reasoning",
			"agentMessage",
			"notice",
			"userMessage",
		]);
		const answer = stopped.items[2];
		expect(answer).toMatchObject({ text: "Half an answ", streaming: false });
		expect(stopped.items[1]).toMatchObject({ durationSeconds: 0 });
		expect(stopped.items[3]).toMatchObject({
			message: STOPPED_NOTICE,
			stopped: true,
		});
		const ask = stopped.items[0];
		expect(ask.kind === "userMessage" && ask.timing?.completedAt).toBe(5_000);
	});

	it("leaves a chat that is not running as it is", () => {
		const idle = { ...running, turnStatus: "idle" as const };
		expect(sessionStoppedByUser(idle, 5_000)).toBe(idle);
	});

	it("does not bounce back when the server's running view of the stopped turn arrives", () => {
		const stopped = sessionStoppedByUser(running, 5_000);
		// Sent before the stop settled: more of the same turn, still running.
		expect(
			progressRevivesStoppedTurn({
				stopRequested: true,
				current: stopped.items,
				next: [
					...running.items.slice(0, 2),
					{
						kind: "agentMessage",
						id: SessionItemId("t:a"),
						text: "Half an answer",
						streaming: true,
					},
				],
				nextStatus: "running",
			}),
		).toBe(true);
		// The settled view replaces it.
		expect(
			progressRevivesStoppedTurn({
				stopRequested: true,
				current: stopped.items,
				next: withStoppedNotice(running.items, "t"),
				nextStatus: "idle",
			}),
		).toBe(false);
	});
});
