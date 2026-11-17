import { z } from "zod";

/**
 * Y²'s proactive side: stall signals, scheduled check-ins and the quiet
 * reply. Pure functions; the crew store (src/server/edge/y-squared-crew-store.ts)
 * keeps the state in the crew's SQLite and arms its ONE alarm for the
 * earliest of: a pending wake, the heartbeat, a schedule, a stall signal.
 */

export const Y_SQUARED_SCHEDULE_TOOL = "schedule";

/**
 * What Y² replies when a proactive wake has nothing the person needs. A
 * model turn must end with some text (an empty reply fails the turn as
 * "missing-final-result"), so quiet is a marker the chat does not show
 * (childTaskPublicItems drops it): no bubble, no noise.
 */
export const Y_SQUARED_QUIET_REPLY = "NOTHING_TO_REPORT";

/** Whether a reply is the quiet marker (case, spacing, quotes and a closing full stop ignored). */
export function isYSquaredQuietReply(text: string) {
	return (
		text.replace(/[\s.`*_"']/g, "").toUpperCase() ===
		Y_SQUARED_QUIET_REPLY.replace(/_/g, "")
	);
}

/** Most active schedules a project may hold. */
export const Y_SQUARED_SCHEDULE_LIMIT = 10;
/** Most proactive wakes (schedules, stall nudges, reminders) per rolling 24 h; event wakes keep their own 24/h cap. */
export const Y_SQUARED_PROACTIVE_WAKES_PER_DAY = 48;
export const Y_SQUARED_DAY_MS = 24 * 60 * 60 * 1000;
export const Y_SQUARED_SCHEDULE_PROMPT_LIMIT = 400;
/** A repeating schedule is never more frequent than this. */
export const Y_SQUARED_SCHEDULE_MIN_EVERY_MINUTES = 30;
/** A one-time check-in overdue by more than this (the project was down) is dropped as missed. */
export const Y_SQUARED_ONCE_MISSED_AFTER_MS = 6 * 60 * 60 * 1000;
/** Done, cancelled and missed schedules are kept this long. */
export const Y_SQUARED_SCHEDULE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** A thread with no history is "stalled" after this (and never sooner than the floor). */
export const STALL_DEFAULT_AFTER_MS = 60 * 60 * 1000;
export const STALL_MIN_AFTER_MS = 20 * 60 * 1000;
/** Working this many times its usual turn duration counts as stalled. */
export const STALL_FACTOR = 3;
/** A thread waiting on the person this long gets a reminder. */
export const WAITING_REMIND_AFTER_MS = 30 * 60 * 1000;
/** At most one reminder per thread per this long ... */
export const WAITING_REMIND_EVERY_MS = 3 * 60 * 60 * 1000;
/** ... and at most this many per wait. */
export const WAITING_REMIND_MAX = 3;
/** A working row older than this is a lost settle note (as for heartbeats). */
const WORKING_MAX_MS = 6 * 60 * 60 * 1000;

export type YSquaredSettings = {
	/** Stall nudges and waiting reminders (default on). */
	readonly stallNudges: boolean;
	/** The person's IANA time zone; null until one was saved (schedules then use UTC). */
	readonly timezone: string | null;
};
export const Y_SQUARED_DEFAULT_SETTINGS: YSquaredSettings = {
	stallNudges: true,
	timezone: null,
};

/** A settings patch from the wire; unusable parts are dropped. */
export function parseSettingsPatch(value: unknown): Partial<YSquaredSettings> {
	if (!value || typeof value !== "object") return {};
	const raw = value as Record<string, unknown>;
	const patch: { stallNudges?: boolean; timezone?: string | null } = {};
	if (typeof raw.stallNudges === "boolean") patch.stallNudges = raw.stallNudges;
	if (raw.timezone !== undefined) {
		const zone = validTimeZone(raw.timezone);
		if (zone) patch.timezone = zone;
	}
	return patch;
}

// ---------------------------------------------------------------- time zones

/** A usable IANA zone name, else null. */
export function validTimeZone(name: unknown): string | null {
	if (typeof name !== "string" || !name.trim() || name.length > 64) return null;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name.trim() });
		return name.trim();
	} catch {
		return null;
	}
}

type LocalParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	weekday: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(ms: number, timeZone: string): LocalParts {
	let format = formatters.get(timeZone);
	if (!format) {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
		});
		formatters.set(timeZone, format);
	}
	const get: Record<string, number> = {};
	for (const part of format.formatToParts(ms))
		if (part.type !== "literal") get[part.type] = Number(part.value);
	return {
		year: get.year as number,
		month: get.month as number,
		day: get.day as number,
		hour: (get.hour as number) % 24,
		minute: get.minute as number,
		weekday: new Date(
			Date.UTC(get.year as number, (get.month as number) - 1, get.day),
		).getUTCDay(),
	};
}

const offsetAt = (ms: number, timeZone: string) => {
	const p = localParts(ms, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
};

/** The UTC instant at which the wall clock in `timeZone` reads this local time (a skipped hour moves forward). */
export function zonedTimeToUtc(
	local: {
		year: number;
		month: number;
		day: number;
		hour: number;
		minute: number;
	},
	timeZone: string,
) {
	const asUtc = Date.UTC(
		local.year,
		local.month - 1,
		local.day,
		local.hour,
		local.minute,
	);
	const first = asUtc - offsetAt(asUtc, timeZone);
	return asUtc - offsetAt(first, timeZone);
}

/** "Mon 2026-11-18 09:00" in `timeZone`. */
export function formatLocal(ms: number, timeZone: string) {
	const p = localParts(ms, timeZone);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.weekday]} ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

// ----------------------------------------------------------------- schedules

export type ScheduleSpec =
	| { readonly kind: "once" }
	| { readonly kind: "every"; readonly minutes: number }
	| {
			readonly kind: "daily";
			/** "HH:MM" local time. */
			readonly time: string;
			/** 0 = Sunday … 6 = Saturday. */
			readonly days: readonly number[];
	  };

export type ScheduleStatus = "active" | "done" | "cancelled" | "missed";

export type ScheduleView = {
	readonly id: string;
	readonly prompt: string;
	readonly spec: ScheduleSpec;
	readonly timezone: string;
	readonly status: ScheduleStatus;
	/** When it is next due (ms); null once it is not active. */
	readonly nextDueAt: number | null;
	readonly lastRunAt: number | null;
};

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** The next time a spec is due strictly after `after`; null for a one-time one (its time is stored). */
export function nextDueAt(
	spec: ScheduleSpec,
	timeZone: string,
	after: number,
): number | null {
	if (spec.kind === "once") return null;
	if (spec.kind === "every") return after + spec.minutes * 60_000;
	const match = TIME.exec(spec.time);
	if (!match) return null;
	const today = localParts(after, timeZone);
	// Calendar days are walked in UTC so a zone's DST never skips or repeats one.
	for (let offset = 0; offset <= 8; offset++) {
		const day = new Date(
			Date.UTC(today.year, today.month - 1, today.day + offset),
		);
		if (!spec.days.includes(day.getUTCDay())) continue;
		const at = zonedTimeToUtc(
			{
				year: day.getUTCFullYear(),
				month: day.getUTCMonth() + 1,
				day: day.getUTCDate(),
				hour: Number(match[1]),
				minute: Number(match[2]),
			},
			timeZone,
		);
		if (at > after) return at;
	}
	return null;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSpec(spec: ScheduleSpec, timeZone: string) {
	if (spec.kind === "once") return "once";
	if (spec.kind === "every")
		return spec.minutes % 60 === 0
			? `every ${spec.minutes / 60} h`
			: `every ${spec.minutes} min`;
	const days = [...spec.days].sort((a, b) => a - b);
	const label =
		days.length === 7
			? "every day"
			: days.join() === "1,2,3,4,5"
				? "every weekday"
				: `every ${days.map((d) => WEEKDAY_NAMES[d]).join(", ")}`;
	return `${label} at ${spec.time} (${timeZone})`;
}

export const scheduleInput = z.object({
	action: z.enum(["create", "list", "cancel"]),
	prompt: z
		.string()
		.trim()
		.max(Y_SQUARED_SCHEDULE_PROMPT_LIMIT)
		.optional()
		.describe(
			"create: what to do when it is due, written as an instruction to yourself (e.g. 'Give the person a digest of what every thread did since yesterday.')",
		),
	inMinutes: z
		.number()
		.int()
		.min(1)
		.max(60 * 24 * 365)
		.optional()
		.describe("create, one time: due this many minutes from now"),
	at: z
		.string()
		.max(40)
		.optional()
		.describe(
			"create, one time: local date and time YYYY-MM-DDTHH:MM in the time zone",
		),
	time: z
		.string()
		.max(5)
		.optional()
		.describe("create, repeating daily: local time HH:MM (24 h)"),
	days: z
		.array(z.number().int().min(0).max(6))
		.max(7)
		.optional()
		.describe(
			"with time: weekdays 0=Sunday … 6=Saturday; default every day; 'every weekday' is [1,2,3,4,5]",
		),
	everyMinutes: z
		.number()
		.int()
		.min(Y_SQUARED_SCHEDULE_MIN_EVERY_MINUTES)
		.max(60 * 24 * 30)
		.optional()
		.describe("create, repeating: every this many minutes (at least 30)"),
	timezone: z
		.string()
		.max(64)
		.optional()
		.describe(
			"create: IANA zone such as Europe/Berlin; default the person's saved zone, else UTC",
		),
	id: z.string().max(64).optional().describe("cancel: the schedule's id"),
});
export type ScheduleInput = z.infer<typeof scheduleInput>;

export const Y_SQUARED_SCHEDULE_DESCRIPTION = `Schedule a check-in for yourself: you wake at the time with the saved prompt. Only when the person asks for one ("every weekday 9am give me a digest", "in 2 hours check on the audit thread"). action "create" needs a prompt and exactly one of: inMinutes, at (local YYYY-MM-DDTHH:MM), time (+ optional days) for a daily or weekday one, or everyMinutes (at least ${Y_SQUARED_SCHEDULE_MIN_EVERY_MINUTES}). "list" shows the active ones with their ids and next due time; "cancel" needs an id. At most ${Y_SQUARED_SCHEDULE_LIMIT} active per project. The result says which time zone was used: if it says UTC, tell the person once that they can set theirs by opening this project's Y settings.`;

export type ScheduleDraft = {
	readonly prompt: string;
	readonly spec: ScheduleSpec;
	readonly timezone: string;
	readonly nextDueAt: number;
};

/** Validates a `create` call: one schedule draft, or what is wrong with it. */
export function parseScheduleCreate(
	input: ScheduleInput,
	context: { readonly now: number; readonly timezone: string | null },
): { ok: true; draft: ScheduleDraft } | { ok: false; error: string } {
	const prompt = (input.prompt ?? "").replace(/\s+/g, " ").trim();
	if (!prompt) return { ok: false, error: "A schedule needs a prompt." };
	if (input.timezone !== undefined && !validTimeZone(input.timezone))
		return {
			ok: false,
			error: `"${input.timezone}" is not an IANA time zone (for example Europe/Berlin).`,
		};
	const timezone = validTimeZone(input.timezone) ?? context.timezone ?? "UTC";
	const kinds = [
		input.inMinutes !== undefined,
		input.at !== undefined,
		input.time !== undefined,
		input.everyMinutes !== undefined,
	].filter(Boolean).length;
	if (kinds !== 1)
		return {
			ok: false,
			error:
				"Give exactly one of inMinutes, at, time (with optional days) or everyMinutes.",
		};
	const { now } = context;
	if (input.inMinutes !== undefined)
		return {
			ok: true,
			draft: {
				prompt,
				spec: { kind: "once" },
				timezone,
				nextDueAt: now + input.inMinutes * 60_000,
			},
		};
	if (input.at !== undefined) {
		const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(
			input.at.trim(),
		);
		if (!match)
			return { ok: false, error: "`at` must look like 2026-11-18T09:00." };
		const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
			number,
		];
		if (
			month < 1 ||
			month > 12 ||
			day < 1 ||
			day > 31 ||
			hour > 23 ||
			minute > 59
		)
			return { ok: false, error: "`at` is not a real date and time." };
		const at = zonedTimeToUtc({ year, month, day, hour, minute }, timezone);
		if (at <= now) return { ok: false, error: "`at` is in the past." };
		return {
			ok: true,
			draft: { prompt, spec: { kind: "once" }, timezone, nextDueAt: at },
		};
	}
	if (input.everyMinutes !== undefined)
		return {
			ok: true,
			draft: {
				prompt,
				spec: { kind: "every", minutes: input.everyMinutes },
				timezone,
				nextDueAt: now + input.everyMinutes * 60_000,
			},
		};
	const match = TIME.exec((input.time ?? "").trim());
	if (!match) return { ok: false, error: "`time` must look like 09:00." };
	const days = [
		...new Set(input.days?.length ? input.days : [0, 1, 2, 3, 4, 5, 6]),
	];
	const spec: ScheduleSpec = {
		kind: "daily",
		time: `${(match[1] as string).padStart(2, "0")}:${match[2]}`,
		days,
	};
	const due = nextDueAt(spec, timezone, now);
	if (due === null) return { ok: false, error: "No due time found." };
	return { ok: true, draft: { prompt, spec, timezone, nextDueAt: due } };
}

/** The active schedules as the list tool prints them. */
export function scheduleLines(schedules: readonly ScheduleView[], now: number) {
	const active = schedules.filter((s) => s.status === "active");
	if (!active.length) return "No active schedules.";
	return active
		.map(
			(s) =>
				`- id ${s.id}: "${s.prompt}" · ${describeSpec(s.spec, s.timezone)} · next ${
					s.nextDueAt === null
						? "never"
						: `${formatLocal(s.nextDueAt, s.timezone)} (${s.timezone}, in ${Math.max(0, Math.round((s.nextDueAt - now) / 60_000))} min)`
				}`,
		)
		.join("\n");
}

// -------------------------------------------------------------- proactive cap

export type ProactiveCap = {
	readonly dayStart: number;
	readonly count: number;
};

/** One proactive wake against the rolling-day cap (separate from the hourly cap of event wakes). */
export function decideProactive(
	cap: ProactiveCap,
	now: number,
	limit = Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
): { allowed: boolean; next: ProactiveCap } {
	const rolled =
		now - cap.dayStart >= Y_SQUARED_DAY_MS ? { dayStart: now, count: 0 } : cap;
	return rolled.count >= limit
		? { allowed: false, next: rolled }
		: { allowed: true, next: { ...rolled, count: rolled.count + 1 } };
}

// --------------------------------------------------------------- stall signals

export type StallRow = {
	readonly sessionId: string;
	readonly title: string;
	readonly state: "working" | "waiting" | "finished" | "failed";
	readonly workingSince: number | null;
	readonly updatedAt: number;
	/** Moving average of this thread's turn durations; 0: unknown. */
	readonly typicalWorkMs: number;
	/** `working_since` of the run already nudged; 0: none. */
	readonly stallNudgedFor: number;
	readonly remindedAt: number;
	readonly remindCount: number;
};

/** How long a working thread may run before it counts as stalled. */
export function stallAfterMs(typicalWorkMs: number) {
	return typicalWorkMs > 0
		? Math.max(STALL_MIN_AFTER_MS, typicalWorkMs * STALL_FACTOR)
		: STALL_DEFAULT_AFTER_MS;
}

/** The moving average of a thread's turn durations after one more settled turn. */
export function nextTypicalWorkMs(previous: number, duration: number) {
	if (duration <= 0 || duration >= WORKING_MAX_MS) return previous;
	return previous > 0 ? Math.round(previous * 0.7 + duration * 0.3) : duration;
}

/** When a row next needs a nudge (stall or reminder); null when none will. */
export function stallDueAt(row: StallRow, now: number): number | null {
	if (row.state === "working" && row.workingSince !== null) {
		if (row.stallNudgedFor === row.workingSince) return null;
		if (now - row.workingSince >= WORKING_MAX_MS) return null;
		return row.workingSince + stallAfterMs(row.typicalWorkMs);
	}
	if (
		(row.state === "waiting" || row.state === "failed") &&
		row.remindCount < WAITING_REMIND_MAX
	)
		return Math.max(
			row.updatedAt + WAITING_REMIND_AFTER_MS,
			row.remindedAt ? row.remindedAt + WAITING_REMIND_EVERY_MS : 0,
		);
	return null;
}

export type StallSignal =
	| {
			readonly kind: "stalled";
			readonly sessionId: string;
			readonly title: string;
			readonly workingMs: number;
			readonly typicalMs: number;
			readonly workingSince: number;
	  }
	| {
			readonly kind: "reminder";
			readonly sessionId: string;
			readonly title: string;
			readonly waitingMs: number;
			readonly failed: boolean;
	  };

/** The stall signals due at `now`. Each fires once per working run, and a reminder at most `WAITING_REMIND_MAX` times per wait. */
export function stallSignals(
	rows: readonly StallRow[],
	now: number,
): StallSignal[] {
	const out: StallSignal[] = [];
	for (const row of rows) {
		const due = stallDueAt(row, now);
		if (due === null || due > now) continue;
		if (row.state === "working" && row.workingSince !== null) {
			out.push({
				kind: "stalled",
				sessionId: row.sessionId,
				title: row.title,
				workingMs: now - row.workingSince,
				typicalMs: row.typicalWorkMs,
				workingSince: row.workingSince,
			});
		} else
			out.push({
				kind: "reminder",
				sessionId: row.sessionId,
				title: row.title,
				waitingMs: now - row.updatedAt,
				failed: row.state === "failed",
			});
	}
	return out;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The wake-body lines for due schedules and stall signals. */
export function proactiveWakeLines(input: {
	readonly signals: readonly StallSignal[];
	readonly schedules: readonly {
		readonly id: string;
		readonly prompt: string;
	}[];
}) {
	const lines: string[] = [];
	if (input.schedules.length) {
		lines.push("Scheduled check-ins that are due (the person asked for them):");
		for (const s of input.schedules) lines.push(`- (${s.id}) ${s.prompt}`);
	}
	if (input.signals.length) {
		lines.push(
			"Follow-up signals (each is sent once; do not repeat them in later wakes):",
		);
		for (const signal of input.signals)
			lines.push(
				signal.kind === "stalled"
					? `- "${signal.title}" has worked ${minutes(signal.workingMs)}${signal.typicalMs ? `, its usual turn is ${minutes(signal.typicalMs)}` : ""}: it may be stuck.`
					: `- "${signal.title}" has been ${signal.failed ? "failed" : "waiting on the person"} for ${minutes(signal.waitingMs)}.`,
			);
	}
	return lines;
}
