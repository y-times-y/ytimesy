import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { YProactiveView } from "./y-mode-settings";

const text = (html: string) => html.replace(/<[^>]+>/g, "");
const noop = () => undefined;
const base = {
	settings: { stallNudges: true, modelChoice: true, timezone: "Europe/Berlin" },
	schedules: [
		{
			id: "ab12cd34",
			prompt: "Weekday digest",
			spec: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] },
			timezone: "Europe/Berlin",
			status: "active",
			nextDueAt: Date.UTC(2026, 10, 23, 8, 0),
			lastRunAt: null,
		},
	],
	proactiveToday: 3,
	proactiveLimit: 48,
} as const;

it("shows the nudge switch, the daily wake count and each schedule with its next time", () => {
	const html = renderToStaticMarkup(
		<YProactiveView
			data={base as never}
			pending={false}
			onStallNudges={noop}
			onModelChoice={noop}
			onCancel={noop}
		/>,
	);
	expect(text(html)).toContain("Nudge stuck and waiting threads");
	expect(html).toContain('id="y-stall-nudges"');
	expect(text(html)).toContain("3 of 48");
	expect(text(html)).toContain("Weekday digest");
	expect(text(html)).toContain("every weekday at 09:00 (Europe/Berlin)");
	expect(text(html)).toContain("next Mon 2026-11-23 09:00");
	expect(text(html)).toContain("Times use Europe/Berlin.");
	expect(text(html)).toContain("Cancel");
});

it("says UTC is used until a time zone is saved, and shows an empty list", () => {
	const html = renderToStaticMarkup(
		<YProactiveView
			data={
				{
					...base,
					settings: { stallNudges: false, modelChoice: false, timezone: null },
					schedules: [],
				} as never
			}
			pending={false}
			onStallNudges={noop}
			onModelChoice={noop}
			onCancel={noop}
		/>,
	);
	expect(text(html)).toContain("Times use UTC until your time zone is saved.");
	expect(text(html)).toContain("No schedules.");
	expect(html).not.toContain("Cancel");
});

it("words the project switch as Y² only, never 'Y and Y²'", async () => {
	const { Y_SQUARED_SWITCH_COPY: copy } = await import("./y-mode-settings");
	expect(copy.title).toBe("Use Y²");
	expect(copy.description).toBe(
		"On by default. Y² stays quiet until you connect a model, and it runs only on your own plan or key. Off: each chat does the work itself.",
	);
	expect(JSON.stringify(copy)).not.toMatch(/Y and Y²/);
});
