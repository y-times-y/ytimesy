import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	CREW_HOUR_MS,
	CREW_RETENTION_MS,
	CREW_WAKE_DELAY_MS,
	CREW_WAKES_PER_HOUR,
	type CrewNote,
	crewFromSettledItems,
	crewProjectFor,
	parseCrewNote,
	parseCrewWaitingHint,
} from "../../domain/y-squared-crew";
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
		count: (table: string) =>
			(db.prepare(`select count(*) as n from ${table}`).get() as { n: number })
				.n,
	};
}

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
const T0 = 1_000_000_000_000;

describe("crew rows", () => {
	it("keeps one row per thread however many turns, and nothing when unchanged", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		for (let turn = 0; turn < 5; turn++) {
			crew.noteThread(note(), T0 + turn);
			crew.noteThread(
				note({ state: "finished", lastReply: `done ${turn}` }),
				T0 + turn,
			);
		}
		expect(db.count("crew")).toBe(1);
		expect(crew.thread("t1")?.lastReply).toBe("done 4");
		// a working note keeps the last reply shown
		crew.noteThread(note(), T0 + 99);
		expect(crew.thread("t1")?.state).toBe("working");
		expect(crew.thread("t1")?.lastReply).toBe("done 4");
	});

	it("bounds the reply to 300 characters and the list to the thread limit", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteThread(
			note({ state: "finished", lastReply: "x".repeat(900) }),
			T0,
		);
		expect(crew.thread("t1")?.lastReply?.length).toBe(300);
		for (let i = 0; i < 40; i++)
			crew.noteThread(note({ sessionId: `s${i}` }), T0 + i);
		expect(crew.list().rows.length).toBe(25);
		expect(crew.list(3).rows.length).toBe(3);
	});

	it("lists needing-person first, then working, then the rest, newest first", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note({ sessionId: "done", state: "finished" }), T0 + 5);
		crew.noteThread(note({ sessionId: "busy", state: "working" }), T0 + 4);
		crew.noteThread(
			note({ sessionId: "asks", state: "waiting", waitingOn: "question" }),
			T0 + 1,
		);
		crew.noteThread(
			note({ sessionId: "broke", state: "failed", waitingOn: "failed" }),
			T0 + 2,
		);
		expect(crew.list().rows.map((row) => row.sessionId)).toEqual([
			"broke",
			"asks",
			"busy",
			"done",
		]);
	});

	it("prunes rows untouched for 30 days", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteThread(note({ sessionId: "old" }), T0);
		crew.noteThread(note({ sessionId: "new" }), T0 + CREW_RETENTION_MS);
		crew.prune(T0 + CREW_RETENTION_MS + 1);
		expect(crew.list().rows.map((row) => row.sessionId)).toEqual(["new"]);
	});

	it("reconciles once from metadata; notes already written win", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note({ sessionId: "a", state: "finished" }), T0);
		const row = (id: string, state: "working" | "finished") => ({
			sessionId: id,
			title: id,
			state,
			waitingOn: null,
			prUrl: null,
			lastReply: null,
			updatedAt: T0 - 1,
		});
		expect(crew.list().reconciled).toBe(false);
		crew.reconcile([row("a", "working"), row("b", "working")]);
		expect(crew.list().reconciled).toBe(true);
		expect(crew.thread("a")?.state).toBe("finished");
		crew.reconcile([row("c", "working")]);
		expect(crew.thread("c")).toBeNull();
	});
});

describe("wakes", () => {
	it("progress notes never wake; a note that matters sets pending and one alarm", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		expect(crew.noteThread(note(), T0).alarmAt).toBeNull();
		expect(crew.wakeState().pending).toBe(false);
		const first = crew.noteThread(note({ state: "finished" }), T0 + 10);
		expect(first.alarmAt).toBe(T0 + 10 + CREW_WAKE_DELAY_MS);
		// more notes before the alarm fires coalesce into the same alarm
		const second = crew.noteThread(
			note({ sessionId: "t2", state: "waiting", waitingOn: "question" }),
			T0 + 20,
		);
		expect(second.alarmAt).toBeNull();
	});

	it("an alarm sends exactly one wake and records it; the next waits 45 s after it", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(note({ state: "finished" }), T0);
		const fired = crew.takeWake(alarmAt as number);
		expect(fired.action).toBe("send");
		expect(crew.wakeState()).toMatchObject({
			pending: false,
			lastWakeAt: alarmAt,
			wakesThisHour: 1,
			alarmAt: null,
		});
		expect(crew.takeWake((alarmAt as number) + 1).action).toBe("none");
		const next = crew.noteThread(
			note({ sessionId: "t2", state: "failed", waitingOn: "failed" }),
			(alarmAt as number) + 1_000,
		);
		expect(next.alarmAt).toBe((alarmAt as number) + 1_000 + CREW_WAKE_DELAY_MS);
	});

	it("caps wakes per hour and holds the extra one until the hour rolls over", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		let now = T0;
		for (let wake = 0; wake < CREW_WAKES_PER_HOUR; wake++) {
			const { alarmAt } = crew.noteThread(
				note({
					state: wake % 2 ? "finished" : "failed",
					waitingOn: wake % 2 ? null : "failed",
					lastReply: `r${wake}`,
				}),
				now,
			);
			now = alarmAt as number;
			expect(crew.takeWake(now).action).toBe("send");
		}
		const { alarmAt } = crew.noteThread(
			note({ sessionId: "t9", state: "finished" }),
			now + 1,
		);
		now = alarmAt as number;
		const capped = crew.takeWake(now);
		expect(capped.action).toBe("capped");
		// the hour window opened at the first wake (T0 + 45 s)
		expect(capped.retryAt).toBe(T0 + CREW_WAKE_DELAY_MS + CREW_HOUR_MS);
		expect(crew.wakeState().pending).toBe(true);
		expect(crew.takeWake(capped.retryAt as number).action).toBe("send");
	});

	it("Y²'s own session id never records a row or wakes", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		expect(
			crew.noteThread(note({ sessionId: "y2", state: "finished" }), T0),
		).toEqual({
			alarmAt: null,
		});
		expect(db.count("crew")).toBe(0);
		expect(crew.wakeState().pending).toBe(false);
	});

	it("a wake that could not be enqueued is handed back, not lost", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(note({ state: "finished" }), T0);
		crew.takeWake(alarmAt as number);
		crew.returnWake();
		expect(crew.wakeState()).toMatchObject({
			pending: true,
			wakesThisHour: 0,
			alarmAt: null,
		});
	});
});

describe("notes", () => {
	it("accepts the old shapes", () => {
		expect(
			parseCrewNote({
				sessionId: "t1",
				userId: "u",
				projectId: "p",
				turnStatus: "completed",
				pullRequest: "https://x/pull/1",
				reply: "ok",
			}),
		).toMatchObject({
			state: "finished",
			prUrl: "https://x/pull/1",
			lastReply: "ok",
		});
		expect(
			parseCrewNote({
				sessionId: "t1",
				userId: "u",
				projectId: "p",
				turnStatus: "running",
			})?.state,
		).toBe("working");
		expect(parseCrewNote({ nonsense: true })).toBeNull();
	});

	it("only a Y project's threads, never Y², send notes", () => {
		const scope = { projectId: "p", yEnabled: true, ySquaredId: "y2" };
		expect(crewProjectFor(scope, "t1")).toBe("p");
		expect(crewProjectFor(scope, "y2")).toBeNull();
		expect(crewProjectFor({ ...scope, yEnabled: false }, "t1")).toBeNull();
		expect(crewProjectFor({ ...scope, projectId: null }, "t1")).toBeNull();
		expect(crewProjectFor(null, "t1")).toBeNull();
	});

	it("derives what a settled turn waits on from its transcript", () => {
		const items = [
			{ kind: "userMessage", id: "a", text: "Add --verbose" },
			{ kind: "agentMessage", id: "b", text: "stdout or stderr?" },
			{ kind: "userQuestion", id: "c" },
		] as never;
		expect(crewFromSettledItems(items, "completed")).toMatchObject({
			state: "waiting",
			waitingOn: "question",
			lastReply: "stdout or stderr?",
			title: "Add --verbose",
		});
		expect(crewFromSettledItems([], "failed").state).toBe("failed");
		expect(crewFromSettledItems([], "completed").state).toBe("finished");
	});
});

describe("waiting hint (a settle note that lost what the thread waits on)", () => {
	const hint = (over = {}) => ({
		sessionId: "t1",
		userId: "u",
		projectId: "p",
		ySquaredId: "y2",
		waitingOn: "question",
		...over,
	});
	const bare = () => note({ state: "finished", lastReply: "Which one?" });

	it("turns an item-less 'finished' settle note into waiting, and wakes once", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		expect(crew.noteWaiting(hint(), T0 + 1_000).alarmAt).toBeNull();
		const settled = crew.noteThread(bare(), T0 + 2_000);
		expect(crew.thread("t1")).toMatchObject({
			state: "waiting",
			waitingOn: "question",
			lastReply: "Which one?",
		});
		expect(settled.alarmAt).toBe(T0 + 2_000 + CREW_WAKE_DELAY_MS);
	});

	it("upgrades a row the settle note already wrote as finished", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		crew.noteThread(bare(), T0 + 1_000);
		expect(crew.thread("t1")?.state).toBe("finished");
		crew.noteWaiting(hint({ waitingOn: "secret" }), T0 + 2_000);
		expect(crew.thread("t1")).toMatchObject({
			state: "waiting",
			waitingOn: "secret",
			lastReply: "Which one?",
		});
	});

	it("never outlives its turn: a new turn, a failure or the TTL retires it", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteThread(note(), T0);
		crew.noteWaiting(hint(), T0 + 1);
		crew.noteThread(note(), T0 + 2); // the person answered; a new turn
		expect(db.count("waiting_hint")).toBe(0);
		crew.noteThread(bare(), T0 + 3);
		expect(crew.thread("t1")?.state).toBe("finished");

		crew.noteThread(note(), T0 + 10);
		crew.noteWaiting(hint(), T0 + 11);
		crew.noteThread(bare(), T0 + 11 + 5 * 60 * 1000 + 1);
		expect(crew.thread("t1")?.state).toBe("finished");
	});

	it("does not override a note that already knows what it waits on, and ignores Y² itself", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteThread(note(), T0);
		crew.noteWaiting(hint(), T0 + 1);
		crew.noteThread(
			note({ state: "waiting", waitingOn: "push", lastReply: "ok" }),
			T0 + 2,
		);
		expect(crew.thread("t1")?.waitingOn).toBe("push");
		crew.noteWaiting(hint({ sessionId: "y2" }), T0 + 3);
		expect(db.count("waiting_hint")).toBe(0);
	});

	it("parses the wire shape and rejects an unusable one", () => {
		expect(parseCrewWaitingHint({ ...hint(), extra: 1 })).toEqual(hint());
		expect(parseCrewWaitingHint({ ...hint(), waitingOn: "" })).toBeNull();
		expect(parseCrewWaitingHint(null)).toBeNull();
	});
});
