import { expect, it } from "vitest";
import { SessionItemId } from "./ids";
import { type SessionItem, sessionViewItems } from "./session-item";
import { recordTurnTiming, workedLabel } from "./turn-timing";

it("preserves timing across runtime IDs and freezes completed durations", () => {
	const items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("queued"), text: "Hi" },
	];
	const started = recordTurnTiming(items, "running", 1000, true);
	const merged = sessionViewItems(
		[{ ...items[0], id: SessionItemId("runtime") }],
		started,
	);
	const completed = recordTurnTiming(merged, "completed", 73000);
	expect(recordTurnTiming(completed, "completed", 90000)).toEqual(completed);
	const user = completed[0];
	expect(user?.kind === "userMessage" && workedLabel(user.timing)).toBe(
		"Worked for 1m 12s",
	);
	expect(workedLabel(undefined)).toBe("Worked");
	expect(workedLabel({ startedAt: 1000, completedAt: 1000 })).toBe("Worked");
	expect(workedLabel({ startedAt: 1000, completedAt: 1200 })).toBe("Worked");
});

it("does not invent timing for history or match a different prompt", () => {
	const old: SessionItem[] = [
		{
			kind: "userMessage",
			id: SessionItemId("old"),
			text: "Hi",
			timing: { startedAt: 1 },
		},
	];
	const next: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("next"), text: "Different" },
	];
	expect(
		recordTurnTiming(sessionViewItems(next, old), "completed", 100),
	).toEqual(next);
});
