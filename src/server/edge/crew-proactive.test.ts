import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	CREW_HEARTBEAT_AFTER_MS,
	type CrewNote,
} from "../../domain/y-squared-crew";
import {
	parseScheduleCreate,
	type ScheduleInput,
	STALL_DEFAULT_AFTER_MS,
	STALL_MIN_AFTER_MS,
	WAITING_REMIND_AFTER_MS,
	WAITING_REMIND_EVERY_MS,
	WAITING_REMIND_MAX,
	Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
	Y_SQUARED_SCHEDULE_LIMIT,
} from "../../domain/y-squared-proactive";
import type { ThreadProgress } from "../adapters/crew-facts";
import { runCrewAlarm } from "./crew-alarm";
import { SqliteYSquaredCrew } from "./y-squared-crew-store";

function sql() {
	const db = new DatabaseSync(":memory:");
	return {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) };
			}
			statement.run(...bindings);
			return { toArray: () => [] };
		},
	};
}

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Friday 2026-11-20 12:00 UTC. */
const T0 = Date.UTC(2026, 10, 20, 12, 0);
const note = (over: Partial<CrewNote> = {}): CrewNote => ({
	sessionId: "t1",
	title: "Audit",
	state: "working",
	waitingOn: null,
	prUrl: null,
	lastReply: null,
	userId: "u",
	projectId: "p",
	ySquaredId: "y2",
	...over,
});

/** The crew as the platform runs it: a store and its one alarm slot. */
function world(
	/** What the threads' turns really did (Postgres), at alarm time `now`. */
	progress?: (
		now: number,
		sessionIds: readonly string[],
	) => readonly ThreadProgress[],
) {
	const store = new SqliteYSquaredCrew(sql() as never);
	let alarm: number | null = null;
	let now = T0;
	const y2 = { turns: [] as string[], failNext: 0 };
	const alarms: number[] = [];
	const note1 = (n: CrewNote, at = now) => {
		now = at;
		const { alarmAt } = store.noteThread(n, at);
		if (alarmAt !== null) alarm = alarmAt;
	};
	const schedule = (
		input: Partial<ScheduleInput>,
		timezone: string | null = null,
	) => {
		const parsed = parseScheduleCreate(
			{
				action: "create",
				prompt: "Give me a digest",
				...input,
			} as ScheduleInput,
			{ now, timezone },
		);
		if (!parsed.ok) throw new Error(parsed.error);
		const result = store.createSchedule(
			parsed.draft,
			{ userId: "u", ySquaredId: "y2" },
			now,
		);
		if (!result.ok) return result;
		if (result.alarmAt !== null) alarm = result.alarmAt;
		return result;
	};
	const fire = async (at?: number) => {
		if (alarm === null) throw new Error("no alarm is set");
		now = Math.max(now, at ?? alarm);
		alarm = null;
		await runCrewAlarm({
			store,
			now,
			enqueue: async (_t, _at, body) => {
				if (y2.failNext > 0) {
					y2.failNext--;
					throw new Error("down");
				}
				y2.turns.push(body);
				return true;
			},
			setAlarm: async (at2) => {
				alarms.push(at2);
				alarm = at2;
			},
			log: () => undefined,
			...(progress
				? {
						progress: async (_user: string, ids: readonly string[]) =>
							progress(now, ids),
					}
				: {}),
		});
	};
	return {
		store,
		y2,
		note1,
		schedule,
		fire,
		alarm: () => alarm,
		now: () => now,
		setNow: (n: number) => (now = n),
	};
}

describe("scheduled check-ins", () => {
	it("arms the one alarm for a schedule and wakes Y² with its prompt, outside the hourly cap", async () => {
		const w = world();
		w.note1(note({ sessionId: "a" }), T0); // a thread must exist so Y² has a target
		w.store.noteThread(note({ sessionId: "a", state: "finished" }), T0 + 1);
		w.schedule({ inMinutes: 120, prompt: "Check on the audit thread" });
		// Earlier: the thread's finish wake (10 s) is the minimum.
		expect(w.alarm()).toBeLessThan(T0 + 120 * MIN);
		await w.fire();
		expect(w.y2.turns[0]).toContain("finished its turn");
		expect(w.y2.turns[0]).not.toContain("Check on the audit thread");
		// After that wake the alarm moved on to the schedule.
		expect(w.alarm()).toBe(T0 + 120 * MIN);
		await w.fire();
		expect(w.y2.turns).toHaveLength(2);
		expect(w.y2.turns[1]).toContain("Check on the audit thread");
		expect(w.y2.turns[1]).toContain("Proactive check-in");
		expect(w.y2.turns[1]).toContain("NOTHING_TO_REPORT");
		expect(w.store.wakeState().wakesThisHour).toBe(1); // only the thread's wake
		expect(w.store.proactiveStatus(w.now()).proactiveToday).toBe(1);
		expect(w.store.schedules()).toEqual([]); // a one-time check-in is done
		expect(w.alarm()).toBeNull();
	});

	it("takes the earliest of pending wake, heartbeat and schedules", () => {
		const w = world();
		w.note1(note(), T0); // working: heartbeat at +5 min
		expect(w.alarm()).toBe(T0 + CREW_HEARTBEAT_AFTER_MS);
		w.schedule({ inMinutes: 3 });
		expect(w.alarm()).toBe(T0 + 3 * MIN);
		w.schedule({ inMinutes: 60 }); // later: the alarm stays
		expect(w.alarm()).toBe(T0 + 3 * MIN);
	});

	it("repeats a weekday schedule in the saved time zone and skips the weekend", async () => {
		const w = world();
		w.note1(note({ state: "finished" }), T0);
		const created = w.schedule(
			{ time: "09:00", days: [1, 2, 3, 4, 5], prompt: "Digest" },
			"Europe/Berlin",
		);
		// Friday 12:00Z is past 09:00 Berlin: next is Monday 09:00 CET = 08:00Z.
		expect(created.ok && created.schedule.nextDueAt).toBe(
			Date.UTC(2026, 10, 23, 8, 0),
		);
		w.setNow(T0 + 20_000);
		await w.fire(); // the thread's finish wake
		await w.fire(); // Monday
		expect(w.y2.turns.at(-1)).toContain("Digest");
		expect(w.store.schedules()[0]?.nextDueAt).toBe(
			Date.UTC(2026, 10, 24, 8, 0),
		);
	});

	it("drops a one-time check-in that is far overdue as missed, and fires a late repeating one once", async () => {
		const w = world();
		w.note1(note({ state: "finished" }), T0);
		w.store.noteThread(note({ state: "finished" }), T0); // no wake due beyond the first
		w.schedule({ inMinutes: 30, prompt: "once" });
		w.schedule({ everyMinutes: 60, prompt: "hourly" });
		await w.fire(); // thread wake at +10 s
		w.setNow(T0 + 10 * HOUR);
		w.store.noteThread(
			note({ state: "finished", title: "Audit 2" }),
			T0 + 10 * HOUR,
		);
		const before = w.y2.turns.length;
		const taken = w.store.takeWake(T0 + 10 * HOUR);
		expect(taken.action).toBe("send");
		const body = "body" in taken ? taken.body : "";
		expect(body).toContain("hourly");
		expect(body).not.toContain("(once)");
		expect(before).toBe(1);
		expect(w.store.schedules().map((s) => s.prompt)).toEqual(["hourly"]);
	});

	it("limits a project to 10 active schedules", () => {
		const w = world();
		for (let i = 0; i < Y_SQUARED_SCHEDULE_LIMIT; i++)
			expect(w.schedule({ inMinutes: 60 + i }).ok).toBe(true);
		const eleventh = w.schedule({ inMinutes: 90 });
		expect(eleventh.ok).toBe(false);
		// Cancelling one makes room.
		const id = w.store.schedules()[0]?.id as string;
		expect(w.store.cancelSchedule(id)).toBe(true);
		expect(w.store.cancelSchedule(id)).toBe(false);
		expect(w.schedule({ inMinutes: 90 }).ok).toBe(true);
	});

	it("a cancelled schedule never fires and leaves no alarm work", async () => {
		const w = world();
		w.note1(note({ state: "finished" }), T0);
		await w.fire();
		const made = w.schedule({ inMinutes: 5 });
		expect(made.ok).toBe(true);
		w.store.cancelSchedule(w.store.schedules()[0]?.id as string);
		const turns = w.y2.turns.length;
		await w.fire(); // the stale alarm: nothing to send
		expect(w.y2.turns).toHaveLength(turns);
		expect(w.alarm()).toBeNull();
	});

	it("counts proactive wakes against their own daily cap, leaving event wakes alone", async () => {
		const w = world();
		w.note1(note({ state: "finished" }), T0);
		w.schedule({ everyMinutes: 30, prompt: "ping" });
		w.schedule({ everyMinutes: 45, prompt: "pong" });
		await w.fire(); // thread wake
		const base = w.y2.turns.length;
		// About 66 check-ins fall due in 20 hours; only 48 may wake Y² per day.
		while (w.alarm() !== null && (w.alarm() as number) <= T0 + 20 * HOUR)
			await w.fire();
		expect(w.y2.turns.length - base).toBe(Y_SQUARED_PROACTIVE_WAKES_PER_DAY);
		expect(w.store.proactiveStatus(w.now()).proactiveToday).toBe(
			Y_SQUARED_PROACTIVE_WAKES_PER_DAY,
		);
		// The hourly cap of event wakes is untouched: a thread ending still wakes Y².
		w.note1(note({ sessionId: "t2", title: "Later" }), w.now() + 1_000);
		w.note1(
			note({ sessionId: "t2", title: "Later", state: "finished" }),
			w.now() + 2_000,
		);
		const turns = w.y2.turns.length;
		await w.fire();
		expect(w.y2.turns.length).toBe(turns + 1);
		expect(w.y2.turns.at(-1)).toContain('"Later" finished');
	});

	it("keeps a due schedule through a failed send without a tight loop, and gives the cap slot back", async () => {
		const w = world();
		w.note1(note({ state: "finished" }), T0);
		await w.fire();
		w.schedule({ inMinutes: 10, prompt: "ping" });
		w.y2.failNext = 1;
		await w.fire(); // due, send fails
		expect(w.y2.turns).toHaveLength(1);
		expect(w.store.proactiveStatus(w.now()).proactiveToday).toBe(0);
		expect(w.alarm()).toBeGreaterThan(w.now()); // a retry later, not now
		await w.fire();
		expect(w.y2.turns.at(-1)).toContain("ping");
		expect(w.store.proactiveStatus(w.now()).proactiveToday).toBe(1);
		expect(w.store.schedules()).toEqual([]);
	});
});

describe("settings", () => {
	it("default stall nudges on, no time zone, and persist a patch", () => {
		const w = world();
		expect(w.store.settings()).toEqual({
			stallNudges: true,
			modelChoice: true,
			timezone: null,
		});
		w.store.saveSettings({ stallNudges: false, timezone: "Asia/Tokyo" }, T0);
		expect(w.store.settings()).toEqual({
			stallNudges: false,
			modelChoice: true,
			timezone: "Asia/Tokyo",
		});
		// Letting Y² choose models is its own switch and survives other patches.
		w.store.saveSettings({ modelChoice: false }, T0);
		expect(w.store.settings().modelChoice).toBe(false);
		w.store.saveSettings({ stallNudges: true }, T0);
		expect(w.store.settings().modelChoice).toBe(false);
		w.store.saveSettings({ modelChoice: true }, T0);
		w.store.saveSettings({ stallNudges: true }, T0);
		expect(w.store.settings().timezone).toBe("Asia/Tokyo");
	});
});

describe("stall signals", () => {
	const runUntil = async (w: ReturnType<typeof world>, limit: number) => {
		while (
			w.alarm() !== null &&
			w.alarm() !== null &&
			(w.alarm() as number) <= limit
		)
			await w.fire();
	};

	it("nudges once when a thread works far longer than its history-less default, no new alarm", async () => {
		const w = world();
		w.note1(note(), T0);
		await runUntil(w, T0 + STALL_DEFAULT_AFTER_MS + MIN);
		const nudges = w.y2.turns.filter((t) => t.includes("may be stuck"));
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toContain('"Audit" has worked 60 min');
		await runUntil(w, T0 + 3 * HOUR);
		expect(w.y2.turns.filter((t) => t.includes("may be stuck"))).toHaveLength(
			1,
		);
	});

	it("uses the thread's own usual turn length once it has one", async () => {
		const w = world();
		w.note1(note(), T0);
		w.note1(note({ state: "finished", lastReply: "ok" }), T0 + 4 * MIN); // a 4-minute turn
		await w.fire(); // the finish wake
		w.note1(note(), T0 + 30 * MIN); // works again
		await runUntil(w, T0 + 30 * MIN + STALL_MIN_AFTER_MS + MIN);
		const nudge = w.y2.turns.find((t) => t.includes("may be stuck"));
		expect(nudge).toContain("usual turn is 4 min");
		expect(w.store.thread("t1")).not.toBeNull();
	});

	it("sends no stall signal when the setting is off", async () => {
		const w = world();
		w.store.saveSettings({ stallNudges: false }, T0);
		w.note1(note(), T0);
		await runUntil(w, T0 + 2 * HOUR);
		expect(w.y2.turns.some((t) => t.includes("may be stuck"))).toBe(false);
	});

	it("reminds once per few hours about a thread waiting on the person, at most three times", async () => {
		const w = world();
		w.note1(note(), T0);
		w.note1(note({ state: "waiting", waitingOn: "question" }), T0 + MIN);
		await w.fire(); // the 'needs you' wake
		expect(w.y2.turns).toHaveLength(1);
		await w.fire();
		expect(w.now()).toBe(T0 + MIN + WAITING_REMIND_AFTER_MS);
		expect(w.y2.turns[1]).toContain("waiting on the person for 30 min");
		for (let i = 1; i < WAITING_REMIND_MAX; i++) {
			expect(w.alarm()).toBe(w.now() + WAITING_REMIND_EVERY_MS);
			await w.fire();
		}
		expect(
			w.y2.turns.filter((t) => t.includes("waiting on the person for")),
		).toHaveLength(WAITING_REMIND_MAX);
		expect(w.alarm()).toBeNull(); // never repeated again
	});

	it("an answered thread drops its reminder", async () => {
		const w = world();
		w.note1(note(), T0);
		w.note1(note({ state: "waiting", waitingOn: "question" }), T0 + MIN);
		await w.fire();
		w.note1(note({ state: "finished" }), T0 + 5 * MIN);
		await w.fire();
		const turns = w.y2.turns.length;
		expect(w.alarm()).toBeNull();
		expect(w.y2.turns).toHaveLength(turns);
	});

	const running = (
		sessionId: string,
		progressAt: number | null,
	): ThreadProgress => ({
		sessionId,
		active: true,
		queued: false,
		progressAt,
		turnStatus: "running",
	});

	it("a long tool call or Claude run whose turn keeps renewing is never called stuck", async () => {
		// The box renews the turn's lease every few seconds while one tool
		// call runs for hours: the crew heard nothing after the start note.
		const w = world((now, ids) => ids.map((id) => running(id, now - 5_000)));
		w.note1(note(), T0);
		await runUntil(w, T0 + 3 * HOUR);
		expect(w.y2.turns.some((t) => t.includes("may be stuck"))).toBe(false);
		// It is checked again later, not given up on.
		expect(w.alarm()).not.toBeNull();
	});

	it("a turn with no progress for the stall window is told, with how long it was quiet", async () => {
		const w = world((_now, ids) => ids.map((id) => running(id, T0 + 5 * MIN)));
		w.note1(note(), T0);
		await runUntil(w, T0 + 2 * HOUR);
		const nudges = w.y2.turns.filter((t) => t.includes("may be stuck"));
		expect(nudges).toHaveLength(1);
		expect(nudges[0]).toContain("has worked 65 min");
		expect(nudges[0]).toContain("shown no progress");
		expect(nudges[0]).toContain("for 60 min");
	});

	it("a thread whose turn already ended is settled, not called stuck", async () => {
		// Its settle note was lost (a sweep failed the turn): no turn runs.
		const w = world((_now, ids) =>
			ids.map((sessionId) => ({
				sessionId,
				active: false,
				queued: false,
				progressAt: null,
				turnStatus: "failed",
			})),
		);
		w.note1(note(), T0);
		await runUntil(w, T0 + 2 * HOUR);
		expect(w.y2.turns.some((t) => t.includes("may be stuck"))).toBe(false);
		expect(w.y2.turns.some((t) => t.includes('"Audit" failed'))).toBe(true);
		expect(w.store.thread("t1")?.state).toBe("failed");
	});

	it("a lost settle note (working > 6 h) arms no stall alarm", () => {
		const w = world();
		w.note1(note(), T0);
		w.store.takeWake(T0 + 7 * HOUR);
		expect(w.store.rearmAfterSend(T0 + 7 * HOUR)).toBeNull();
	});
});
