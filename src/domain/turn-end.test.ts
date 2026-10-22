import { describe, expect, it } from "vitest";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	STOPPED_NOTICE,
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
