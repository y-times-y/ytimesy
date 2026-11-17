import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	CREW_WAKE_DELAY_MS,
	CREW_WAKE_RETRIES,
	type CrewNote,
	wakeRetryDelayMs,
} from "../../domain/y-squared-crew";
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

const T0 = 1_000_000_000_000;
const note = (over: Partial<CrewNote> = {}): CrewNote => ({
	sessionId: "t1",
	title: "Fix sign-up",
	state: "working",
	waitingOn: null,
	prUrl: null,
	lastReply: null,
	userId: "u",
	projectId: "p",
	ySquaredId: "y2",
	...over,
});

/**
 * The crew object as the platform runs it: a store, one alarm slot (the
 * earliest set wins like the real storage: a later set replaces it), and Y²'s
 * chat that is idle or mid-turn. A wake into an idle Y² starts a turn; into
 * a busy one it queues and starts when that turn ends.
 */
function world() {
	const store = new SqliteYSquaredCrew(sql() as never);
	let alarm: number | null = null;
	let now = T0;
	const y2 = {
		busy: false,
		turns: [] as string[],
		queued: [] as string[],
		failNext: 0,
		unsendable: false,
	};
	const logs: string[] = [];
	const note1 = (n: CrewNote, at = now) => {
		now = at;
		const { alarmAt } = store.noteThread(n, at);
		if (alarmAt !== null) alarm = alarmAt;
	};
	const fire = async () => {
		if (alarm === null) throw new Error("no alarm is set");
		now = Math.max(now, alarm);
		alarm = null;
		await runCrewAlarm({
			store,
			now,
			enqueue: async (_target, _at, body) => {
				if (y2.failNext > 0) {
					y2.failNext--;
					throw new Error("connection timeout");
				}
				if (y2.unsendable) return false;
				if (y2.busy) y2.queued.push(body);
				else y2.turns.push(body);
				return true;
			},
			setAlarm: async (at) => {
				alarm = at;
			},
			log: (line) => logs.push(line),
		});
	};
	const y2TurnEnds = () => {
		y2.busy = false;
		const next = y2.queued.shift();
		if (next !== undefined) {
			y2.turns.push(next);
			y2.busy = true;
		}
	};
	return {
		store,
		y2,
		logs,
		note1,
		fire,
		y2TurnEnds,
		alarm: () => alarm,
		now: () => now,
	};
}

const finish = (id: string, title: string) =>
	note({
		sessionId: id,
		title,
		state: "finished",
		lastReply: `${title} is done.`,
	});

describe("a thread's turn end reaches Y²", () => {
	it("wakes an idle Y² once, 30 s after the turn ended, naming the thread", async () => {
		const w = world();
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 5_000);
		expect(w.alarm()).toBe(T0 + 5_000 + CREW_WAKE_DELAY_MS);
		await w.fire();
		expect(w.y2.turns).toHaveLength(1);
		expect(w.y2.turns[0]).toContain('"Fix sign-up" finished its turn');
		expect(w.y2.turns[0]).toContain("short delta");
		expect(w.alarm()).toBeNull();
	});

	it("queues the wake behind a busy Y², and delivers it when that turn ends", async () => {
		const w = world();
		w.y2.busy = true;
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 5_000);
		await w.fire();
		expect(w.y2.turns).toHaveLength(0);
		expect(w.y2.queued).toHaveLength(1);
		w.y2TurnEnds();
		expect(w.y2.turns).toHaveLength(1);
		expect(w.y2.turns[0]).toContain('"Fix sign-up" finished its turn');
	});

	it("tells all of several threads that end close together in one wake", async () => {
		const w = world();
		for (const [id, title] of [
			["a", "Form"],
			["b", "Test"],
			["c", "Other forms"],
		] as const)
			w.note1(note({ sessionId: id, title }), T0);
		w.note1(finish("a", "Form"), T0 + 4_000);
		w.note1(finish("b", "Test"), T0 + 9_000);
		w.note1(finish("c", "Other forms"), T0 + 20_000);
		await w.fire();
		expect(w.y2.turns).toHaveLength(1);
		for (const title of ["Form", "Test", "Other forms"])
			expect(w.y2.turns[0]).toContain(`"${title}" finished`);
	});

	it("a thread that ends right after a wake gets its own wake, not lost", async () => {
		const w = world();
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 1_000);
		await w.fire();
		w.note1(note({ sessionId: "t2", title: "Add test" }), w.now() + 1_000);
		w.note1(finish("t2", "Add test"), w.now() + 2_000);
		expect(w.alarm()).not.toBeNull();
		await w.fire();
		expect(w.y2.turns).toHaveLength(2);
		expect(w.y2.turns[1]).toContain('"Add test" finished');
		expect(w.y2.turns[1]).not.toContain("Fix sign-up");
	});

	it("keeps the wake and its changes when sending fails, and retries until it lands", async () => {
		const w = world();
		w.y2.failNext = 2;
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 1_000);
		await w.fire();
		expect(w.y2.turns).toHaveLength(0);
		// An alarm is set again by itself: no later note needed.
		const first = w.alarm() as number;
		expect(first).toBe(w.now() + wakeRetryDelayMs(1));
		await w.fire();
		expect(w.y2.turns).toHaveLength(0);
		expect(w.alarm()).toBe(w.now() + wakeRetryDelayMs(2));
		await w.fire();
		expect(w.y2.turns).toHaveLength(1);
		expect(w.y2.turns[0]).toContain('"Fix sign-up" finished its turn');
		expect(w.alarm()).toBeNull();
		expect(w.logs.some((line) => line.includes('"enqueued":true'))).toBe(true);
	});

	it("does not spend the hourly wake budget on failed sends", async () => {
		const w = world();
		w.y2.failNext = 3;
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 1_000);
		for (let i = 0; i < 4; i++) await w.fire();
		expect(w.y2.turns).toHaveLength(1);
		expect(w.store.wakeState().wakesThisHour).toBe(1);
	});

	it("when Y²'s chat cannot be sent into, retries a bounded number of times, then the next note re-arms it", async () => {
		const w = world();
		w.y2.unsendable = true;
		w.note1(note(), T0);
		w.note1(finish("t1", "Fix sign-up"), T0 + 1_000);
		for (let i = 0; i < CREW_WAKE_RETRIES; i++) await w.fire();
		expect(w.alarm()).toBeNull();
		expect(w.y2.turns).toHaveLength(0);
		// Y²'s chat is readable again; the next thread note brings the wake back,
		// still carrying the earlier turn end.
		w.y2.unsendable = false;
		w.note1(note({ sessionId: "t2", title: "Add test" }), w.now() + 60_000);
		w.note1(finish("t2", "Add test"), w.now() + 61_000);
		await w.fire();
		expect(w.y2.turns).toHaveLength(1);
		expect(w.y2.turns[0]).toContain('"Fix sign-up" finished');
		expect(w.y2.turns[0]).toContain('"Add test" finished');
	});
});

describe("retry delays", () => {
	it("grow from 30 s and stop at 5 minutes", () => {
		expect([1, 2, 3, 4, 5, 6].map(wakeRetryDelayMs)).toEqual([
			30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
		]);
	});
});
