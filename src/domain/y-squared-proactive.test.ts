import { describe, expect, it } from "vitest";
import { childTaskPublicItems } from "./child-task-activity";
import type { SessionItem } from "./session-item";
import {
	decideProactive,
	formatLocal,
	isYSquaredQuietReply,
	nextDueAt,
	nextTypicalWorkMs,
	parseScheduleCreate,
	parseSettingsPatch,
	type ScheduleInput,
	type StallRow,
	stallAfterMs,
	stallSignals,
	validTimeZone,
	Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
	zonedTimeToUtc,
} from "./y-squared-proactive";

const MIN = 60_000;
const FRI_NOON = Date.UTC(2026, 10, 20, 12, 0);
const create = (
	input: Partial<ScheduleInput>,
	timezone: string | null = null,
) =>
	parseScheduleCreate(
		{ action: "create", prompt: "digest", ...input } as ScheduleInput,
		{ now: FRI_NOON, timezone },
	);

describe("time zones", () => {
	it("converts wall-clock time across DST and rejects unknown zones", () => {
		// Berlin is UTC+1 in November, UTC+2 in July.
		expect(
			zonedTimeToUtc(
				{ year: 2026, month: 11, day: 23, hour: 9, minute: 0 },
				"Europe/Berlin",
			),
		).toBe(Date.UTC(2026, 10, 23, 8, 0));
		expect(
			zonedTimeToUtc(
				{ year: 2026, month: 7, day: 23, hour: 9, minute: 0 },
				"Europe/Berlin",
			),
		).toBe(Date.UTC(2026, 6, 23, 7, 0));
		expect(
			zonedTimeToUtc(
				{ year: 2026, month: 11, day: 23, hour: 9, minute: 0 },
				"America/Los_Angeles",
			),
		).toBe(Date.UTC(2026, 10, 23, 17, 0));
		expect(validTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
		expect(validTimeZone("Mars/Base")).toBeNull();
		expect(validTimeZone("")).toBeNull();
		expect(formatLocal(Date.UTC(2026, 10, 23, 8, 0), "Europe/Berlin")).toBe(
			"Mon 2026-11-23 09:00",
		);
	});

	it("keeps 9:00 local across the autumn DST change", () => {
		// Sunday 2026-10-25 the clocks go back in Berlin.
		const spec = {
			kind: "daily",
			time: "09:00",
			days: [0, 1, 2, 3, 4, 5, 6],
		} as const;
		const sat = Date.UTC(2026, 9, 24, 7, 0); // Sat 09:00 CEST
		// Sunday 09:00 is already CET (UTC+1): one hour later in UTC.
		expect(nextDueAt(spec, "Europe/Berlin", sat)).toBe(
			Date.UTC(2026, 9, 25, 8, 0),
		);
		expect(nextDueAt(spec, "Europe/Berlin", Date.UTC(2026, 9, 25, 8, 0))).toBe(
			Date.UTC(2026, 9, 26, 8, 0),
		);
	});
});

describe("parseScheduleCreate", () => {
	it("one-time by minutes, by local time, and repeating", () => {
		const inTwo = create({ inMinutes: 120 });
		expect(inTwo.ok && inTwo.draft.nextDueAt).toBe(FRI_NOON + 120 * MIN);
		const at = create({ at: "2026-11-21T09:30" }, "Asia/Tokyo");
		expect(at.ok && at.draft.nextDueAt).toBe(Date.UTC(2026, 10, 21, 0, 30));
		const every = create({ everyMinutes: 90 });
		expect(every.ok && every.draft.spec).toEqual({
			kind: "every",
			minutes: 90,
		});
	});

	it("weekdays at 9 in the given zone, defaulting to UTC when none is saved", () => {
		const utc = create({ time: "9:00", days: [1, 2, 3, 4, 5] });
		expect(utc.ok && utc.draft.timezone).toBe("UTC");
		expect(utc.ok && utc.draft.nextDueAt).toBe(Date.UTC(2026, 10, 23, 9, 0));
		const saved = create(
			{ time: "09:00", days: [1, 2, 3, 4, 5] },
			"America/New_York",
		);
		// Friday 09:00 in New York (14:00Z) is still ahead of Friday noon UTC.
		expect(saved.ok && saved.draft.nextDueAt).toBe(
			Date.UTC(2026, 10, 20, 14, 0),
		);
		const given = create(
			{ time: "09:00", timezone: "Asia/Tokyo" },
			"America/New_York",
		);
		expect(given.ok && given.draft.timezone).toBe("Asia/Tokyo");
	});

	it("refuses unusable requests", () => {
		expect(create({ prompt: " ", inMinutes: 5 }).ok).toBe(false);
		expect(create({}).ok).toBe(false);
		expect(create({ inMinutes: 5, everyMinutes: 60 }).ok).toBe(false);
		expect(create({ at: "2026-11-19T09:00" }).ok).toBe(false); // past
		expect(create({ at: "tomorrow" }).ok).toBe(false);
		expect(create({ time: "25:00" }).ok).toBe(false);
		expect(create({ time: "09:00", timezone: "Nope/Zone" }).ok).toBe(false);
	});
});

describe("proactive cap", () => {
	it("allows 48 per rolling day, then refuses until the window rolls", () => {
		let cap = { dayStart: 0, count: 0 };
		for (let i = 0; i < Y_SQUARED_PROACTIVE_WAKES_PER_DAY; i++) {
			const d = decideProactive(cap, FRI_NOON + i);
			expect(d.allowed).toBe(true);
			cap = d.next;
		}
		expect(decideProactive(cap, FRI_NOON + 1000).allowed).toBe(false);
		expect(decideProactive(cap, FRI_NOON + 24 * 60 * MIN + 1).allowed).toBe(
			true,
		);
	});
});

describe("stall signals", () => {
	const row = (over: Partial<StallRow>): StallRow => ({
		sessionId: "t",
		title: "Audit",
		state: "working",
		workingSince: FRI_NOON,
		updatedAt: FRI_NOON,
		typicalWorkMs: 0,
		stallNudgedFor: 0,
		remindedAt: 0,
		remindCount: 0,
		...over,
	});

	it("stalls at 3x its usual turn (at least 20 min), 60 min without history", () => {
		expect(stallAfterMs(0)).toBe(60 * MIN);
		expect(stallAfterMs(4 * MIN)).toBe(20 * MIN);
		expect(stallAfterMs(30 * MIN)).toBe(90 * MIN);
		expect(stallSignals([row({})], FRI_NOON + 59 * MIN)).toEqual([]);
		expect(stallSignals([row({})], FRI_NOON + 60 * MIN)).toHaveLength(1);
		expect(
			stallSignals([row({ stallNudgedFor: FRI_NOON })], FRI_NOON + 90 * MIN),
		).toEqual([]);
	});

	it("learns a thread's usual duration and ignores absurd ones", () => {
		expect(nextTypicalWorkMs(0, 10 * MIN)).toBe(10 * MIN);
		expect(nextTypicalWorkMs(10 * MIN, 20 * MIN)).toBe(13 * MIN);
		expect(nextTypicalWorkMs(10 * MIN, 8 * 60 * MIN)).toBe(10 * MIN);
	});

	it("reminds about a waiting thread after 30 min, then every 3 h, three times", () => {
		const waiting = row({ state: "waiting", workingSince: null });
		expect(stallSignals([waiting], FRI_NOON + 29 * MIN)).toEqual([]);
		expect(stallSignals([waiting], FRI_NOON + 30 * MIN)).toHaveLength(1);
		const again = row({
			state: "waiting",
			workingSince: null,
			remindedAt: FRI_NOON + 30 * MIN,
			remindCount: 1,
		});
		expect(stallSignals([again], FRI_NOON + 3 * 60 * MIN)).toEqual([]);
		expect(stallSignals([again], FRI_NOON + 210 * MIN)).toHaveLength(1);
		expect(
			stallSignals([{ ...again, remindCount: 3 }], FRI_NOON + 24 * 60 * MIN),
		).toEqual([]);
	});
});

describe("quiet reply", () => {
	it("recognises only the marker, not real text", () => {
		expect(isYSquaredQuietReply("NOTHING_TO_REPORT")).toBe(true);
		expect(isYSquaredQuietReply(" nothing_to_report. ")).toBe(true);
		expect(isYSquaredQuietReply("`NOTHING_TO_REPORT`")).toBe(true);
		expect(isYSquaredQuietReply("Nothing to report on A, but B failed.")).toBe(
			false,
		);
		expect(isYSquaredQuietReply("")).toBe(false);
	});

	it("renders no bubble: the chat as the browser gets it drops the marker", () => {
		const items = [
			{ kind: "agentMessage", id: "a", text: "NOTHING_TO_REPORT" },
			{ kind: "agentMessage", id: "b", text: "A finished." },
		] as unknown as SessionItem[];
		expect(childTaskPublicItems(items).map((item) => item.id)).toEqual(["b"]);
	});
});

describe("settings patch", () => {
	it("keeps only valid fields", () => {
		expect(
			parseSettingsPatch({
				stallNudges: false,
				timezone: "Europe/Paris",
				x: 1,
			}),
		).toEqual({
			stallNudges: false,
			timezone: "Europe/Paris",
		});
		expect(
			parseSettingsPatch({ stallNudges: "no", timezone: "Bad/Zone" }),
		).toEqual({});
		expect(parseSettingsPatch({ modelChoice: false })).toEqual({
			modelChoice: false,
		});
		expect(parseSettingsPatch({ modelChoice: "off" })).toEqual({});
		expect(parseSettingsPatch(null)).toEqual({});
	});
});
