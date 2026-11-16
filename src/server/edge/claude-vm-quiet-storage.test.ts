import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
	nextParkedVmQuiet,
	parkedVmPauseAt,
	parkedVmPauseCheck,
} from "../../domain/claude-parked-turn";
import { SqliteClaudeVmQuiet } from "./claude-vm-quiet-storage";

/** Durable Object SQL over node:sqlite: just the exec/toArray the store uses. */
function sqlStorage() {
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
	} as unknown as SqlStorage;
}

const TURN = "33333333-3333-4333-8333-333333333333";
const GRACE = 10_000;

/** What the chat object does after a step and when it parks (executor.ts). */
function afterStep(
	store: SqliteClaudeVmQuiet,
	noted: Parameters<typeof nextParkedVmQuiet>[0]["noted"],
	pausedAt: number | null = null,
) {
	store.write(
		nextParkedVmQuiet({
			turnId: TURN,
			previous: store.read(),
			noted,
			pausedAt: () => pausedAt,
		}),
	);
}

describe("Claude VM quiet storage and scheduling", () => {
	it("schedules one wake after a tool call, checks at once after a quiet step", () => {
		const store = new SqliteClaudeVmQuiet(sqlStorage());
		expect(store.read()).toBeNull();
		// A step whose tool call returned at 1_000 parks at 3_000.
		afterStep(store, {
			vm: "vm-1",
			userId: "u",
			since: 1_000,
			toolEnded: true,
		});
		expect(
			parkedVmPauseAt({
				now: 3_000,
				turnId: TURN,
				quiet: store.read(),
				graceMs: GRACE,
			}),
		).toBe(11_000);
		// Lines woke a step at 40_000 that ran no tool: the quiet still dates
		// from 1_000, so the park checks the VM at once (no extra wake).
		afterStep(store, {
			vm: "vm-1",
			userId: "u",
			since: 40_000,
			toolEnded: false,
		});
		expect(
			parkedVmPauseAt({
				now: 40_500,
				turnId: TURN,
				quiet: store.read(),
				graceMs: GRACE,
			}),
		).toBe(40_500);
		expect(
			parkedVmPauseCheck({
				now: 40_500,
				quiet: store.read(),
				parkedTurn: TURN,
				stepping: false,
				pendingCalls: 0,
				graceMs: GRACE,
			}).check,
		).toBe(true);
	});

	it("keeps a pause made while parked across the object's restart", () => {
		const sql = sqlStorage();
		const store = new SqliteClaudeVmQuiet(sql);
		afterStep(store, {
			vm: "vm-1",
			userId: "u",
			since: 1_000,
			toolEnded: true,
		});
		store.markPaused(TURN, 12_000);
		// A new instance (hibernation, deploy) reads the same record.
		const restarted = new SqliteClaudeVmQuiet(sql);
		expect(restarted.read()).toMatchObject({ vm: "vm-1", pausedAt: 12_000 });
		// No second pause is scheduled for it.
		expect(
			parkedVmPauseAt({
				now: 20_000,
				turnId: TURN,
				quiet: restarted.read(),
				graceMs: GRACE,
			}),
		).toBeNull();
		// A step that resumed it (its guest operation) clears the pause.
		afterStep(restarted, {
			vm: "vm-1",
			userId: "u",
			since: 30_000,
			toolEnded: true,
		});
		expect(restarted.read()?.pausedAt).toBeNull();
		restarted.write(null);
		expect(restarted.read()).toBeNull();
	});
});
