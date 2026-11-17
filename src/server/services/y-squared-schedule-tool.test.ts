import { describe, expect, it, vi } from "vitest";
import { Y_SQUARED_TOOLS } from "#/domain/y-squared";
import type { YSquaredScheduleResult } from "../adapters/y-squared-crew-client";
import { ySquaredTools } from "./y-squared-tools";

const NOW = Date.UTC(2026, 10, 20, 12, 0);
const run = (
	schedule:
		| ((input: unknown, target: never) => Promise<YSquaredScheduleResult>)
		| null,
	input: unknown,
) => {
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		deps: {
			now: () => NOW,
			crew: () => (schedule ? ({ schedule } as never) : null),
		},
	});
	return (
		tools.schedule as { execute: (i: unknown, o: unknown) => Promise<string> }
	).execute(input, { toolCallId: "c", messages: [] });
};
const view = {
	id: "ab12cd34",
	prompt: "Weekday digest",
	spec: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] },
	timezone: "UTC",
	status: "active",
	nextDueAt: Date.UTC(2026, 10, 23, 9, 0),
	lastRunAt: null,
} as const;

describe("the schedule tool", () => {
	it("is one of Y²'s tools and is handed the user and Y²'s own chat", async () => {
		expect(Y_SQUARED_TOOLS.has("schedule")).toBe(true);
		const schedule = vi.fn(async () => ({
			ok: true as const,
			action: "create" as const,
			schedule: view as never,
			usedUtcFallback: true,
		}));
		const out = await run(schedule, {
			action: "create",
			prompt: "Weekday digest",
			time: "09:00",
			days: [1, 2, 3, 4, 5],
		});
		expect(schedule).toHaveBeenCalledWith(expect.anything(), {
			userId: "u",
			ySquaredId: "y2",
		});
		expect(out).toContain("Scheduled (id ab12cd34)");
		expect(out).toContain("every weekday at 09:00 (UTC)");
		expect(out).toContain("Mon 2026-11-23 09:00");
		expect(out).toContain("UTC was used");
	});

	it("does not nag about UTC when a zone was saved; lists and cancels", async () => {
		const created = await run(
			async () => ({
				ok: true,
				action: "create",
				schedule: view as never,
				usedUtcFallback: false,
			}),
			{ action: "create", prompt: "x", inMinutes: 5 },
		);
		expect(created).not.toContain("UTC was used");
		expect(
			await run(
				async () => ({ ok: true, action: "list", schedules: [view as never] }),
				{ action: "list" },
			),
		).toContain("id ab12cd34");
		expect(
			await run(async () => ({ ok: true, action: "list", schedules: [] }), {
				action: "list",
			}),
		).toBe("No active schedules.");
		expect(
			await run(
				async () => ({ ok: true, action: "cancel", cancelled: false }),
				{ action: "cancel", id: "zz" },
			),
		).toBe("No active schedule with that id.");
	});

	it("reports the crew's refusal and the absence of a crew", async () => {
		expect(
			await run(
				async () => ({
					ok: false,
					error:
						"This project already has 10 active schedules. Cancel one first.",
				}),
				{
					action: "create",
					prompt: "x",
					inMinutes: 5,
				},
			),
		).toContain("already has 10 active schedules");
		expect(await run(null, { action: "list" })).toContain("not available here");
	});
});
