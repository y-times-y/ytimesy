import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posted = vi.hoisted(() => ({ calls: [] as { userId: string; topics: string[] }[] }));
vi.mock("./realtime-delivery", () => ({
	postUserHubNote: async (note: { userId: string; topics: string[] }) => {
		posted.calls.push(note);
	},
}));

import { HUB_NOTE_COALESCE_MS, noteUserHub } from "./user-hub-notes";

beforeEach(() => {
	vi.useFakeTimers();
	posted.calls.length = 0;
	process.env.YTIMESY_USER_HUB_USERS = "*";
});
afterEach(() => {
	vi.useRealTimers();
});

describe("noteUserHub coalescing", () => {
	it("sends a burst for one user as one note after one short window", async () => {
		noteUserHub("u1", ["sessions:p1"]);
		noteUserHub("u1", ["sessions:p1", "projects"]);
		noteUserHub("u1", ["sessions"]);
		expect(posted.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(HUB_NOTE_COALESCE_MS);
		expect(posted.calls).toEqual([
			{ userId: "u1", topics: ["sessions:p1", "projects", "sessions"] },
		]);
	});
	it("keeps users apart and sends again after the window", async () => {
		noteUserHub("u1", ["projects"]);
		noteUserHub("u2", ["projects"]);
		await vi.advanceTimersByTimeAsync(HUB_NOTE_COALESCE_MS);
		expect(posted.calls.map((call) => call.userId).sort()).toEqual(["u1", "u2"]);
		noteUserHub("u1", ["sessions"]);
		await vi.advanceTimersByTimeAsync(HUB_NOTE_COALESCE_MS);
		expect(posted.calls).toHaveLength(3);
	});
	it("sends nothing for a user without the hub", async () => {
		process.env.YTIMESY_USER_HUB_USERS = "someone-else";
		noteUserHub("u1", ["projects"]);
		await vi.advanceTimersByTimeAsync(HUB_NOTE_COALESCE_MS * 2);
		expect(posted.calls).toEqual([]);
	});
});
