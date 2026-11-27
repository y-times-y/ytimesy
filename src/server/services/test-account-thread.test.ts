import { beforeEach, describe, expect, it, vi } from "vitest";

const notes = vi.hoisted(() => ({
	calls: [] as [string, string | null | undefined][],
}));
vi.mock("../adapters/list-change-notes", () => ({
	noteSessionsChanged: (userId: string, projectId?: string | null) => {
		notes.calls.push([userId, projectId]);
	},
}));

import { seedTestThread } from "./test-account-thread";

function fakeDb(rows: Record<string, unknown>[][]) {
	const queries: string[] = [];
	return {
		queries,
		db: {
			query: async (sql: string) => {
				queries.push(sql);
				return { rows: rows.shift() ?? [] };
			},
		},
	};
}

beforeEach(() => {
	notes.calls.length = 0;
});

describe("seedTestThread (what a Y²-started thread does, without a model)", () => {
	it("start adds a running thread to the project's list and tells the hub", async () => {
		const { db } = fakeDb([
			[{ project_id: "p1", workspace_id: "w1" }],
			[{ id: "t1" }],
		]);
		const result = await seedTestThread(db as never, "u1", "start");
		expect(result).toEqual({ threadId: expect.any(String), status: "running" });
		expect(notes.calls).toEqual([["u1", "p1"]]);
	});
	it("settle finishes the seeded thread and tells the hub", async () => {
		const { db } = fakeDb([[{ id: "t1", project_id: "p1" }]]);
		const result = await seedTestThread(db as never, "u1", "settle");
		expect(result).toEqual({ threadId: "t1", status: "completed" });
		expect(notes.calls).toEqual([["u1", "p1"]]);
	});
	it("settle with no seeded thread says so and tells nobody", async () => {
		const { db } = fakeDb([[]]);
		await expect(seedTestThread(db as never, "u1", "settle")).rejects.toThrow(
			/no seeded thread/i,
		);
		expect(notes.calls).toEqual([]);
	});
});
