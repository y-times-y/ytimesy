import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rearmLostTurnAlarm } from "./turn-alarm-repair";

function world(options: { turn?: boolean; wakes?: [string, number][] }) {
	const db = new DatabaseSync(":memory:");
	db.exec(`create table turn_loop(id integer primary key check(id=1), turn_id text not null);
		create table conversation_wake(purpose text primary key,at integer not null)`);
	if (options.turn) db.exec("insert into turn_loop values(1,'t1')");
	for (const [purpose, at] of options.wakes ?? [])
		db.prepare("insert into conversation_wake values(?,?)").run(purpose, at);
	const sql = {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const statement = db.prepare(query);
			if (/^\s*select/i.test(query)) {
				const rows = statement.all(...bindings);
				return { toArray: () => rows.map((row) => ({ ...row })) } as never;
			}
			statement.run(...bindings);
			return { toArray: () => [] } as never;
		},
	};
	const set: number[] = [];
	const logs: string[] = [];
	return {
		db,
		sql,
		set,
		logs,
		run: (now: number, alarm: number | null) =>
			rearmLostTurnAlarm({
				sql,
				now,
				getAlarm: async () => alarm,
				setAlarm: async (at) => {
					set.push(at);
				},
				log: (line) => logs.push(line),
			}),
	};
}

const NOW = 1_000_000;

describe("rearmLostTurnAlarm", () => {
	it("does nothing for an idle object", async () => {
		const w = world({});
		expect(await w.run(NOW, null)).toBe("nothing-to-run");
		expect(w.set).toEqual([]);
	});

	it("leaves an alarm the platform still holds alone", async () => {
		const w = world({ turn: true, wakes: [["turn", NOW - 5_000]] });
		expect(await w.run(NOW, NOW + 1_000)).toBe("alarm-set");
		expect(w.set).toEqual([]);
	});

	it("sets a dropped alarm again for the turn's recorded wake, at once when it is overdue", async () => {
		const w = world({ turn: true, wakes: [["turn", NOW - 200_000]] });
		expect(await w.run(NOW, null)).toBe("armed");
		expect(w.set).toEqual([NOW]);
		expect(w.logs[0]).toContain("turn.alarm_rearmed");
	});

	it("keeps a future wake's time (a parked turn's next renewal)", async () => {
		const w = world({ turn: true, wakes: [["turn", NOW + 8_000]] });
		await w.run(NOW, null);
		expect(w.set).toEqual([NOW + 8_000]);
	});

	it("uses the earliest of the turn and room wakes", async () => {
		const w = world({
			turn: true,
			wakes: [
				["turn", NOW + 8_000],
				["room", NOW + 2_000],
			],
		});
		await w.run(NOW, null);
		expect(w.set).toEqual([NOW + 2_000]);
	});

	it("resumes a turn that has no recorded wake at all, and records it", async () => {
		const w = world({ turn: true });
		expect(await w.run(NOW, null)).toBe("armed");
		expect(w.set).toEqual([NOW]);
		const rows = w.db.prepare("select purpose,at from conversation_wake").all();
		expect(rows).toEqual([{ purpose: "turn", at: NOW }]);
	});

	it("re-arms a room lease expiry with no turn running", async () => {
		const w = world({ wakes: [["room", NOW + 30_000]] });
		expect(await w.run(NOW, null)).toBe("armed");
		expect(w.set).toEqual([NOW + 30_000]);
	});

	it("is safe to repeat: a second run after the alarm is set changes nothing", async () => {
		const w = world({ turn: true });
		await w.run(NOW, null);
		expect(await w.run(NOW + 1, NOW)).toBe("alarm-set");
		expect(w.set).toEqual([NOW]);
	});
});
