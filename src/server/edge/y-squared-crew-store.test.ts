import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	CREW_BURST_GAP_MS,
	CREW_HEARTBEAT_AFTER_MS,
	CREW_HEARTBEAT_EVERY_MS,
	CREW_HOUR_MS,
	CREW_RETENTION_MS,
	CREW_STARTED_WAKE_EVERY_MS,
	CREW_URGENT_WAKE_DELAY_MS,
	CREW_URGENT_WAKES_PER_HOUR,
	CREW_WAKE_DELAY_MS,
	CREW_WAKES_PER_HOUR,
	CREW_WORKING_MAX_MS,
	CREW_Y2_SENT_TTL_MS,
	type CrewNote,
	crewFromSettledItems,
	crewProjectFor,
	crewRequestFromStartItems,
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
		// a working note only arms the heartbeat, never a wake
		expect(crew.noteThread(note(), T0).alarmAt).toBe(
			T0 + CREW_HEARTBEAT_AFTER_MS,
		);
		expect(crew.wakeState().pending).toBe(false);
		const first = crew.noteThread(note({ state: "finished" }), T0 + 10);
		expect(first.alarmAt).toBe(T0 + 10 + CREW_WAKE_DELAY_MS);
		// more notes before the alarm fires coalesce into the same alarm...
		const more = crew.noteThread(
			note({ sessionId: "t3", state: "finished" }),
			T0 + 15,
		);
		expect(more.alarmAt).toBeNull();
		// ...and a needs-you note is just as immediate (no later than the alarm)
		const second = crew.noteThread(
			note({ sessionId: "t2", state: "waiting", waitingOn: "question" }),
			T0 + 20,
		);
		expect(second.alarmAt).toBeNull();
		expect(CREW_URGENT_WAKE_DELAY_MS).toBe(0);
	});

	it("an alarm sends exactly one wake and records it; the next waits 15 s after it", () => {
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
		// a note 1 s after a wake is due right away (the burst gap is 1 s)
		expect(next.alarmAt).toBe((alarmAt as number) + CREW_BURST_GAP_MS);
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
			const taken = crew.takeWake(now);
			expect(taken.action).toBe("send");
			if (taken.action === "send") crew.wakeSent(taken.eventsUpTo);
		}
		const { alarmAt } = crew.noteThread(
			note({ sessionId: "t9", state: "finished" }),
			now + 1,
		);
		now = alarmAt as number;
		const capped = crew.takeWake(now);
		expect(capped.action).toBe("capped");
		// the hour window opened at the first wake (T0)
		expect(capped.retryAt).toBe(T0 + CREW_HOUR_MS);
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
		expect(settled.alarmAt).toBe(T0 + 2_000 + CREW_URGENT_WAKE_DELAY_MS);
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

describe("created, last request and last activity", () => {
	it("records created once, the last request, and bumps last active on every note", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		expect(crew.thread("t1")).toMatchObject({
			createdAt: T0,
			lastActiveAt: T0,
			lastRequest: null,
		});
		crew.noteThread(
			note({
				state: "finished",
				lastReply: "Done",
				lastRequest: "Add --verbose",
			}),
			T0 + 60_000,
		);
		// the next turn's start note carries no request: the last one stays
		crew.noteThread(note(), T0 + 120_000);
		expect(crew.thread("t1")).toMatchObject({
			createdAt: T0,
			lastActiveAt: T0 + 120_000,
			lastRequest: "Add --verbose",
			lastReply: "Done",
		});
		crew.noteThread(
			note({
				state: "finished",
				lastReply: "Done",
				lastRequest: "x".repeat(500),
			}),
			T0 + 180_000,
		);
		expect(crew.thread("t1")?.lastRequest).toHaveLength(200);
		expect(crew.thread("t1")?.createdAt).toBe(T0);
	});

	it("an unchanged note writes nothing, a new request does", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const settled = note({
			state: "finished",
			lastReply: "ok",
			lastRequest: "A",
		});
		crew.noteThread(settled, T0);
		crew.noteThread(settled, T0 + 1000);
		expect(crew.thread("t1")?.lastActiveAt).toBe(T0);
		crew.noteThread({ ...settled, lastRequest: "B" }, T0 + 2000);
		expect(crew.thread("t1")).toMatchObject({
			lastRequest: "B",
			lastActiveAt: T0 + 2000,
		});
	});

	it("lists the most recently active first within a state", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const done = (id: string) =>
			note({ sessionId: id, state: "finished", lastReply: "ok" });
		crew.noteThread(done("old"), T0);
		crew.noteThread(done("new"), T0 + 5000);
		expect(crew.list().rows.map((row) => row.sessionId)).toEqual([
			"new",
			"old",
		]);
	});

	it("adds the columns to a table an earlier deploy made, keeping its rows", () => {
		const db = sql();
		db.exec(`create table crew(
			session_id text primary key, title text not null, state text not null,
			waiting_on text, pr_url text, last_reply text, updated_at integer not null)`);
		db.exec(
			"insert into crew values('old','Old thread','finished',null,null,'Done',?)",
			T0,
		);
		const crew = new SqliteYSquaredCrew(db as never);
		expect(crew.thread("old")).toMatchObject({
			title: "Old thread",
			createdAt: 0,
			lastRequest: null,
			lastActiveAt: T0,
			lastReply: "Done",
		});
		// a second start (the object wakes again) adds nothing and keeps the data
		const again = new SqliteYSquaredCrew(db as never);
		expect(again.thread("old")?.lastActiveAt).toBe(T0);
		crew.noteThread(
			note({
				sessionId: "old",
				state: "finished",
				lastReply: "Done",
				lastRequest: "Q",
			}),
			T0 + 1,
		);
		expect(crew.thread("old")).toMatchObject({
			createdAt: 0,
			lastRequest: "Q",
		});
	});

	it("takes the last request from a settled transcript, never from a wake", () => {
		const items = [
			{ kind: "userMessage", id: "a", text: "Add --verbose" },
			{ kind: "agentMessage", id: "b", text: "Done" },
			{ kind: "userMessage", id: "c", text: "Now add --quiet" },
			{ kind: "userMessage", id: "d", text: "PR merged", wake: true },
			{ kind: "agentMessage", id: "e", text: "Added" },
		] as never;
		expect(crewFromSettledItems(items, "completed")).toMatchObject({
			lastRequest: "Now add --quiet",
			title: "Add --verbose",
		});
		expect(
			parseCrewNote({
				sessionId: "t",
				userId: "u",
				projectId: "p",
				state: "finished",
				lastRequest: "  hi\n there ",
			})?.lastRequest,
		).toBe("hi there");
	});
});

/** Fires the alarm and insists it sends (narrows the result). */
function fire(crew: SqliteYSquaredCrew, at: number) {
	const fired = crew.takeWake(at);
	if (fired.action !== "send")
		throw new Error(`expected a send, got ${fired.action}`);
	return fired;
}

describe("wake policy: debounce by kind", () => {
	it.each([
		["finished", CREW_WAKE_DELAY_MS],
		["waiting", CREW_URGENT_WAKE_DELAY_MS],
		["failed", CREW_URGENT_WAKE_DELAY_MS],
	] as const)("a %s turn wakes after %i ms", (state, delay) => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(
			note({ state, waitingOn: state === "waiting" ? "question" : null }),
			T0,
		);
		expect(alarmAt).toBe(T0 + delay);
	});

	it("wakes on every turn settle, not only a whole thread done", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		let now = T0;
		for (let turn = 0; turn < 3; turn++) {
			crew.noteThread(note(), now);
			now += 10_000;
			const { alarmAt } = crew.noteThread(
				note({ state: "finished", lastReply: `done ${turn}` }),
				now,
			);
			expect(alarmAt).not.toBeNull();
			now = alarmAt as number;
			fire(crew, now);
			now += 60_000;
		}
		expect(crew.wakeState().wakesThisHour).toBe(3);
	});
});

describe("wake policy: long-running heartbeat", () => {
	it("arms one alarm 5 min after a thread starts, then every 10 min, and names who is working", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		expect(crew.noteThread(note(), T0).alarmAt).toBe(
			T0 + CREW_HEARTBEAT_AFTER_MS,
		);
		// a second working note re-arms nothing
		expect(
			crew.noteThread(note({ sessionId: "t2", title: "Docs" }), T0 + 60_000)
				.alarmAt,
		).toBeNull();
		// A heartbeat with nothing new sends no wake (it could only be answered
		// NOTHING_TO_REPORT, a model turn for no message), but the clock moves on.
		const first = crew.takeWake(T0 + CREW_HEARTBEAT_AFTER_MS);
		expect(first.action).toBe("none");
		expect(first.rearmAt).toBe(
			T0 + CREW_HEARTBEAT_AFTER_MS + CREW_HEARTBEAT_EVERY_MS,
		);
		expect(crew.wakeState().wakesThisHour).toBe(0);
		// a real change after it still wakes, and names who is working
		crew.noteThread(
			note({ sessionId: "t2", title: "Docs", state: "finished" }),
			T0 + CREW_HEARTBEAT_AFTER_MS + 1_000,
		);
		const second = fire(crew, T0 + CREW_HEARTBEAT_AFTER_MS + 20_000);
		expect(second.body).toContain('"Fix sign-up" still working, 5 min.');
		expect(crew.wakeState().wakesThisHour).toBe(1);
	});

	it("a wake in between restarts the five minutes", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		crew.noteThread(note({ sessionId: "t2" }), T0);
		const settled = crew.noteThread(
			note({ sessionId: "t2", state: "finished" }),
			T0 + 240_000,
		);
		expect(settled.alarmAt).toBe(T0 + 240_000 + CREW_WAKE_DELAY_MS);
		const fired = fire(crew, T0 + 240_000 + CREW_WAKE_DELAY_MS);
		// t1 has been quiet only since that wake
		expect(fired.rearmAt).toBe(
			T0 + 240_000 + CREW_WAKE_DELAY_MS + CREW_HEARTBEAT_AFTER_MS,
		);
		expect(fired.body).toContain('"Fix sign-up" still working, 4 min.');
	});

	it("sets no alarm when nothing is working, and none is left behind", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		const { alarmAt } = crew.noteThread(
			note({ state: "finished" }),
			T0 + 1_000,
		);
		const fired = fire(crew, alarmAt as number);
		expect(fired.rearmAt).toBeNull();
		expect(crew.wakeState().alarmAt).toBeNull();
		// a stale alarm that fires with nothing to do sends nothing and arms nothing
		const idle = crew.takeWake(T0 + 3_600_000);
		expect(idle).toMatchObject({ action: "none", rearmAt: null });
	});

	it("an early alarm sends nothing and sets the real one", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		const early = crew.takeWake(T0 + 1_000);
		expect(early).toMatchObject({
			action: "none",
			rearmAt: T0 + CREW_HEARTBEAT_AFTER_MS,
		});
		expect(crew.wakeState().wakesThisHour).toBe(0);
	});

	it("ignores a thread 'working' for over six hours (a lost settle note)", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		const late = crew.takeWake(T0 + CREW_WORKING_MAX_MS + 1_000);
		expect(late).toMatchObject({ action: "none", rearmAt: null });
	});

	it("counts toward the hourly cap and a capped heartbeat is not left pending", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		let now = T0;
		for (let i = 0; i < CREW_WAKES_PER_HOUR; i++) {
			const { alarmAt } = crew.noteThread(
				note({ sessionId: `t${i}`, state: "finished" }),
				now,
			);
			now = alarmAt as number;
			fire(crew, now);
		}
		const started = crew.noteThread(note({ sessionId: "w" }), now);
		const capped = crew.takeWake(started.alarmAt as number);
		expect(capped.action).toBe("capped");
		expect(crew.wakeState().pending).toBe(false);
		// the next hour window sends the heartbeat
		const retry = fire(crew, capped.retryAt as number);
		expect(retry.body).toContain("still working");
	});
});

describe("wake policy: threads the person starts themselves", () => {
	const direct = (over: Partial<CrewNote> = {}) =>
		note({ lastRequest: "Fix the sign-up form", ...over });

	it("a thread the person started wakes Y² and Y² is told what they asked", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(direct(), T0);
		expect(alarmAt).toBe(T0 + CREW_WAKE_DELAY_MS);
		expect(crew.wakeState().pending).toBe(true);
		const fired = fire(crew, alarmAt as number);
		expect(fired.body).toContain(
			'The person started "Fix sign-up" themselves (Fix the sign-up form).',
		);
	});

	it("wakes at most once per thread per 10 minutes; the rest are only told at the next wake", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		const first = crew.noteThread(direct(), T0);
		fire(crew, first.alarmAt as number);
		crew.wakeSent(99);
		crew.noteThread(note({ state: "finished" }), T0 + 60_000);
		fire(crew, T0 + 60_000 + CREW_WAKE_DELAY_MS);
		crew.wakeSent(99);
		// the person messages the same thread again two minutes in: no wake
		crew.noteThread(direct({ lastRequest: "Also add a test" }), T0 + 120_000);
		expect(crew.wakeState().pending).toBe(false);
		expect(db.count("wake_events")).toBe(1);
		// ...Y² still hears of it with the next wake
		crew.noteThread(note({ state: "finished" }), T0 + 150_000);
		const next = fire(crew, T0 + 150_000 + CREW_WAKE_DELAY_MS);
		expect(next.body).toContain(
			'You were not part of this: "Fix sign-up" got a message from the person (Also add a test).',
		);
		// after ten minutes a new start wakes again
		crew.noteThread(
			direct({ lastRequest: "One more" }),
			T0 + CREW_STARTED_WAKE_EVERY_MS + 1_000,
		);
		expect(crew.wakeState().pending).toBe(true);
	});

	it("never wakes for a thread Y² itself sent into or started", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteY2Sent("t1", T0);
		crew.noteThread(direct(), T0 + 1_000);
		expect(crew.wakeState().pending).toBe(false);
		// a thread Y² started is new: its id was not known when it marked
		crew.noteY2Sent(null, T0);
		crew.noteThread(direct({ sessionId: "fresh" }), T0 + 2_000);
		expect(crew.wakeState().pending).toBe(false);
		expect(db.count("wake_events")).toBe(0);
		// each mark is used once
		crew.noteThread(note({ state: "finished" }), T0 + 3_000);
		crew.noteThread(direct(), T0 + 4_000);
		expect(crew.wakeState().pending).toBe(true);
	});

	it("keeps the person's direct message for the thread until Y² sends into it", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(direct(), T0);
		expect(crew.thread("t1")).toMatchObject({
			personMessage: "Fix the sign-up form",
			personMessageAt: T0,
		});
		crew.noteY2Sent("t1", T0 + 1_000);
		expect(crew.thread("t1")?.personMessage).toBeNull();
	});

	it("the wake marks the person's message as already delivered, once", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(direct(), T0);
		const body = fire(crew, alarmAt as number).body;
		expect(body).toContain(
			"Already delivered to the thread by the person; do not re-send.",
		);
		expect(body).toContain("never restate what the person said");
		expect(body.split("never forward, paraphrase").length).toBe(2);
	});

	it("a Y² mark older than its life no longer hides the person's own message", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteY2Sent("t1", T0);
		crew.noteThread(direct(), T0 + CREW_Y2_SENT_TTL_MS + 1_000);
		expect(crew.wakeState().pending).toBe(true);
	});

	it("a start with no request (a wake or an automatic turn) is not the person's message", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		expect(crew.wakeState().pending).toBe(false);
	});

	it("keeps the changes for a wake that could not be sent", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		const { alarmAt } = crew.noteThread(
			note({ state: "finished", prUrl: "https://x/pull/12" }),
			T0,
		);
		const fired = fire(crew, alarmAt as number);
		expect(fired.body).toContain(
			'"Fix sign-up" finished its turn (pull request https://x/pull/12).',
		);
		crew.returnWake();
		expect(db.count("wake_events")).toBe(1);
		crew.wakeSent(fired.eventsUpTo);
		expect(db.count("wake_events")).toBe(0);
	});
});

describe("working since", () => {
	it("is set by the start note, kept by repeats, cleared on settle and listed", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note(), T0);
		expect(crew.thread("t1")?.workingSince).toBe(T0);
		crew.noteThread(note({ lastRequest: "more" }), T0 + 5_000);
		expect(crew.thread("t1")?.workingSince).toBe(T0);
		expect(crew.list().rows[0]?.workingSince).toBe(T0);
		crew.noteThread(note({ state: "finished" }), T0 + 9_000);
		expect(crew.thread("t1")?.workingSince).toBeNull();
		crew.noteThread(note(), T0 + 20_000);
		expect(crew.thread("t1")?.workingSince).toBe(T0 + 20_000);
	});

	it("takes the sidebar's start time when reconciled", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.reconcile([
			{
				sessionId: "s",
				title: "S",
				state: "working",
				waitingOn: null,
				prUrl: null,
				lastReply: null,
				lastRequest: null,
				updatedAt: T0,
				createdAt: 0,
				lastActiveAt: 0,
				workingSince: T0 - 60_000,
			},
		]);
		expect(crew.thread("s")?.workingSince).toBe(T0 - 60_000);
	});
});

describe("the start note's request", () => {
	const msg = (text: string, wake = false) =>
		({
			kind: "userMessage",
			id: "m",
			text,
			...(wake ? { wake: true } : {}),
		}) as never;

	it("is the person's message the turn began with, never a wake or an older one", () => {
		expect(crewRequestFromStartItems([msg("Fix  the\nform")])).toBe(
			"Fix the form",
		);
		expect(
			crewRequestFromStartItems([msg("older"), msg("tick", true)]),
		).toBeNull();
		expect(
			crewRequestFromStartItems([
				msg("ask"),
				{ kind: "agentMessage", id: "a", text: "ok" } as never,
			]),
		).toBeNull();
		expect(crewRequestFromStartItems([])).toBeNull();
		expect(crewRequestFromStartItems([msg("x".repeat(500))])?.length).toBe(200);
	});
});

describe("a thread that ran queued turns wakes Y²", () => {
	it("settle then the next turn's start still leaves a due wake aimed at Y²", () => {
		const db = sql();
		const crew = new SqliteYSquaredCrew(db as never);
		crew.noteThread(note({ state: "working" }), T0);
		// Turn one settles while turn two is queued: the settle note is still sent.
		const settled = crew.noteThread(
			note({ state: "finished", lastReply: "done" }),
			T0 + 1_000,
		);
		expect(settled.alarmAt).toBe(T0 + 1_000 + CREW_WAKE_DELAY_MS);
		crew.noteThread(
			note({ state: "working", lastRequest: "second" }),
			T0 + 1_001,
		);
		const decided = crew.takeWake(T0 + 1_000 + CREW_WAKE_DELAY_MS);
		expect(decided.action).toBe("send");
		expect(crew.target()).toEqual({ userId: "u", sessionId: "y2" });
	});
});

describe("a canvas the turn showed", () => {
	const canvas = (title: string, revision: number, html = "<p>BIGHTML</p>") =>
		({
			kind: "canvas",
			id: `c-${title}-${revision}`,
			title,
			revision,
			html,
		}) as never;
	const user = (id: string, text: string) =>
		({ kind: "userMessage", id, text }) as never;

	it("crewFromSettledItems names the canvases of the last turn only, by title and revision, never html", () => {
		const items = [
			user("u1", "make art"),
			canvas("Old", 1),
			user("u2", "revise"),
			canvas("Thread art", 1),
			canvas("Thread art", 2),
			{ kind: "agentMessage", id: "a1", text: "Done." } as never,
		];
		const derived = crewFromSettledItems(items, "completed");
		expect(derived.canvas).toBe('showed canvas "Thread art" (revision 2)');
		expect(derived.canvas).not.toContain("BIGHTML");
		expect(
			crewFromSettledItems([user("u1", "hi")], "completed").canvas,
		).toBeNull();
		expect(
			crewFromSettledItems(
				[user("u", "x"), canvas("A", 1), canvas("B", 3)],
				"completed",
			).canvas,
		).toBe('showed canvas "A" (revision 1), canvas "B" (revision 3)');
	});

	it("rides the finished event into the wake body in one line, not into the crew rows", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const { alarmAt } = crew.noteThread(
			note({
				state: "finished",
				lastReply: "Revised.",
				canvas: 'showed canvas "Thread art" (revision 2)',
			}),
			T0,
		);
		const fired = crew.takeWake(alarmAt as number);
		if (fired.action !== "send") throw new Error("expected a wake");
		expect(fired.body).toContain(
			'- "Fix sign-up" finished its turn (showed canvas "Thread art" (revision 2)).',
		);
		expect(fired.body).toContain("call `show_canvas` again");
		expect(JSON.stringify(crew.list())).not.toContain("Thread art");
		expect(fired.body.length).toBeLessThan(1_500);
	});

	it("a turn with a new revision is news even when its reply did not change", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		const first = crew.noteThread(
			note({ state: "finished", lastReply: "Same." }),
			T0,
		);
		crew.takeWake(first.alarmAt as number);
		const again = crew.noteThread(
			note({
				state: "finished",
				lastReply: "Same.",
				canvas: 'showed canvas "A" (revision 2)',
			}),
			T0 + 60_000,
		);
		expect(again.alarmAt).not.toBeNull();
	});

	it("parseCrewNote keeps a short canvas line and drops an overlong one", () => {
		const raw = {
			sessionId: "t1",
			userId: "u",
			projectId: "p",
			state: "finished",
			canvas: "x".repeat(900),
		};
		expect(parseCrewNote(raw)?.canvas).toHaveLength(200);
		expect(parseCrewNote({ ...raw, canvas: undefined })?.canvas).toBeNull();
	});
});

describe("instant wakes (2026-11-25)", () => {
	it("the first event after a quiet period wakes at once, finished or needs-you", () => {
		for (const over of [
			{ state: "finished" as const },
			{ state: "waiting" as const, waitingOn: "question" },
			{ state: "failed" as const, waitingOn: "failed" },
		]) {
			const crew = new SqliteYSquaredCrew(sql() as never);
			expect(crew.noteThread(note(over), T0 + 7).alarmAt).toBe(T0 + 7);
			expect(crew.takeWake(T0 + 7).action).toBe("send");
		}
	});

	it("an identical burst within 1 s of a wake coalesces into one later wake with every event", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(note({ state: "finished" }), T0);
		expect(crew.takeWake(T0).action).toBe("send");
		const a = crew.noteThread(
			note({ sessionId: "a", title: "a", state: "finished", lastReply: "A" }),
			T0 + 100,
		);
		const b = crew.noteThread(
			note({ sessionId: "b", title: "b", state: "finished", lastReply: "B" }),
			T0 + 400,
		);
		expect(a.alarmAt).toBe(T0 + CREW_BURST_GAP_MS);
		expect(b.alarmAt).toBeNull();
		const sent = crew.takeWake(T0 + CREW_BURST_GAP_MS);
		expect(sent.action).toBe("send");
		if (sent.action !== "send") return;
		expect(sent.body).toContain('"a" finished');
		expect(sent.body).toContain('"b" finished');
	});

	it("the wake carries the thread's result, question, pull request, canvas and failure reason", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		crew.noteThread(
			note({
				sessionId: "ok",
				title: "Ship it",
				state: "finished",
				prUrl: "https://github.com/o/r/pull/9",
				result: "Added the retry button and its test.",
				canvas: 'showed canvas "Retry flow" (revision 2)',
			}),
			T0,
		);
		crew.noteThread(
			note({
				sessionId: "q",
				title: "Pick DB",
				state: "waiting",
				waitingOn: "question",
				ask: 'asks "Which database?" options: Postgres / SQLite',
			}),
			T0 + 1,
		);
		crew.noteThread(
			note({
				sessionId: "bad",
				title: "Build",
				state: "failed",
				waitingOn: "failed",
				failure: "The build box ran out of disk",
			}),
			T0 + 2,
		);
		const sent = crew.takeWake(T0 + 2);
		if (sent.action !== "send") throw new Error("expected a wake");
		expect(sent.body).toContain('said: "Added the retry button and its test."');
		expect(sent.body).toContain("pull/9");
		expect(sent.body).toContain("Which database?");
		expect(sent.body).toContain("Retry flow");
		expect(sent.body).toContain("failure: The build box ran out of disk");
		expect(sent.body).toContain("call `thread` only for a thread whose line");
	});

	it("caps: finished wakes stop at the soft cap, needs-you and failed go on to the hard ceiling", () => {
		const crew = new SqliteYSquaredCrew(sql() as never);
		let now = T0;
		let replies = 0;
		const wake = (over: Partial<CrewNote>) => {
			const { alarmAt } = crew.noteThread(
				note({ ...over, lastReply: `r${replies++}` }),
				now,
			);
			now = Math.max(now, alarmAt ?? now);
			const taken = crew.takeWake(now);
			if (taken.action === "send") crew.wakeSent(taken.eventsUpTo);
			return taken.action;
		};
		for (let i = 0; i < CREW_WAKES_PER_HOUR; i++)
			expect(wake({ state: "finished" })).toBe("send");
		expect(wake({ state: "finished", sessionId: "x" })).toBe("capped");
		// a person waiting is still woken past the soft cap (the pending finished one rides along)
		expect(
			wake({ state: "waiting", waitingOn: "question", sessionId: "w" }),
		).toBe("send");
		for (let i = CREW_WAKES_PER_HOUR + 1; i < CREW_URGENT_WAKES_PER_HOUR; i++)
			expect(
				wake({ state: "failed", waitingOn: "failed", sessionId: `f${i}` }),
			).toBe("send");
		// the hard ceiling still stops a loop
		expect(
			wake({ state: "failed", waitingOn: "failed", sessionId: "loop" }),
		).toBe("capped");
	});
});
