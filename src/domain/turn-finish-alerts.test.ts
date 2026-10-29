import { describe, expect, it } from "vitest";
import { finishedChats, tabTitle } from "./turn-finish-alerts";

describe("finishedChats", () => {
	it("names chats that stopped running, by how they ended", () => {
		const finished = finishedChats(new Set(["a", "b", "c", "d"]), [
			{ id: "a", title: "A", running: false, turnStatus: "completed" },
			{ id: "b", title: "B", running: false, turnStatus: "failed" },
			{ id: "c", title: "C", running: false, waitingOn: "question" },
			{ id: "d", title: "D", running: true, turnStatus: "running" },
			{ id: "e", title: "E", running: false, turnStatus: "completed" },
		]);
		expect(finished).toEqual([
			{ id: "a", title: "A", outcome: "finished" },
			{ id: "b", title: "B", outcome: "failed" },
			{ id: "c", title: "C", outcome: "needs-you" },
		]);
	});
});

describe("tabTitle", () => {
	it("adds the dot once and takes it off", () => {
		const marked = tabTitle("ytimesy", true);
		expect(marked).toBe("● ytimesy");
		expect(tabTitle(marked, true)).toBe(marked);
		expect(tabTitle(marked, false)).toBe("ytimesy");
	});
});
