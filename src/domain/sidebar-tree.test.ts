import { describe, expect, it } from "vitest";
import {
	recentSections,
	type SidebarChat,
	type SidebarStatusGroup,
} from "./sidebar-chats";
import {
	THREADS_SETTLED_AFTER,
	threadSections,
	y2NeedsYouLabel,
	y2Rows,
	y2Summary,
} from "./sidebar-tree";

const alpha = { id: "alpha" };
const beta = { id: "beta" };
const y2 = (updatedAt?: string): SidebarChat => ({
	id: "y2",
	title: "Y²",
	role: "y2",
	updatedAt,
});
const thread = (id: string, updatedAt?: string): SidebarChat => ({
	id,
	title: id,
	updatedAt,
});
const statusFrom =
	(statuses: Record<string, SidebarStatusGroup>) => (chat: SidebarChat) =>
		statuses[chat.id] ?? "done";

describe("y2Summary", () => {
	it("counts what works and what needs the person", () => {
		expect(y2Summary({ working: 2, needsYou: 1, total: 5 })).toBe(
			"2 working · 1 needs you",
		);
		expect(y2Summary({ working: 0, needsYou: 3, total: 3 })).toBe(
			"3 needs you",
		);
		expect(y2Summary({ working: 1, needsYou: 0, total: 1 })).toBe("1 working");
	});

	it("says All idle with the thread count, or that there are none", () => {
		expect(y2Summary({ working: 0, needsYou: 0, total: 3 })).toBe(
			"All idle · 3 threads",
		);
		expect(y2Summary({ working: 0, needsYou: 0, total: 1 })).toBe(
			"All idle · 1 thread",
		);
		expect(y2Summary({ working: 0, needsYou: 0, total: 0 })).toBe(
			"No threads yet",
		);
	});
});

describe("y2Rows", () => {
	const groups = [
		{
			project: alpha,
			chats: [
				y2("2026-10-01T00:00:00Z"),
				thread("a-run", "2026-10-02T00:00:00Z"),
				thread("a-ask", "2026-10-03T00:00:00Z"),
				thread("a-done", "2026-10-04T00:00:00Z"),
			],
		},
		{
			project: beta,
			chats: [{ ...y2("2026-10-10T00:00:00Z"), id: "y2b" }],
		},
	];
	const sections = recentSections(groups);
	const rows = y2Rows({
		y2: sections.y2,
		threads: sections.y,
		statusOf: statusFrom({ "a-run": "working", "a-ask": "needs-you" }),
	});

	it("makes one row per Y project with its summary and counts", () => {
		const row = rows.find((r) => r.project.id === "alpha");
		expect(rows).toHaveLength(2);
		expect(row).toMatchObject({
			working: 1,
			needsYou: 1,
			total: 3,
			summary: "1 working · 1 needs you",
		});
		expect(rows.find((r) => r.project.id === "beta")?.summary).toBe(
			"No threads yet",
		);
	});

	it("takes the newest of the Y² chat's and its threads' activity, newest project first", () => {
		expect(rows.map((r) => r.project.id)).toEqual(["beta", "alpha"]);
		expect(rows[1]?.activityAt).toBe("2026-10-04T00:00:00Z");
	});

	it("makes no row for a project without Y", () => {
		const plain = recentSections([
			{ project: alpha, chats: [thread("p1", "2026-10-01T00:00:00Z")] },
		]);
		expect(
			y2Rows({ y2: plain.y2, threads: plain.y, statusOf: () => "done" }),
		).toEqual([]);
		expect(plain.plain).toHaveLength(1);
	});
});

describe("threadSections", () => {
	const row = (id: string) => ({ chat: thread(id), project: alpha });
	const many = (count: number, from = 0) =>
		Array.from({ length: count }, (_, i) => row(`d${from + i}`));

	it("orders Needs you, then Working, then Done, each in the order given", () => {
		const rows = [row("d1"), row("w1"), row("n1"), row("d2"), row("n2")];
		const out = threadSections(
			rows,
			statusFrom({ w1: "working", n1: "needs-you", n2: "needs-you" }),
		);
		expect(out.list.map((r) => r.chat.id)).toEqual([
			"n1",
			"n2",
			"w1",
			"d1",
			"d2",
		]);
		expect(out.settled).toEqual([]);
	});

	it("folds finished threads past the first few into Settled, active ones never", () => {
		const rows = [...many(8), row("w1")];
		const out = threadSections(rows, statusFrom({ w1: "working" }));
		expect(THREADS_SETTLED_AFTER).toBe(5);
		expect(out.list.map((r) => r.chat.id)).toEqual([
			"w1",
			...many(5).map((r) => r.chat.id),
		]);
		expect(out.settled.map((r) => r.chat.id)).toEqual(["d5", "d6", "d7"]);
	});

	it("keeps the open thread out of Settled", () => {
		const out = threadSections(many(8), statusFrom({}), "d7");
		expect(out.list.map((r) => r.chat.id)).toContain("d7");
		expect(out.settled.map((r) => r.chat.id)).toEqual(["d5", "d6"]);
	});

	it("keeps the order it was given, so pinned rows (sorted first upstream) stay in view", () => {
		const sections = recentSections(
			[
				{
					project: alpha,
					chats: [
						y2(),
						...Array.from({ length: 8 }, (_, i) =>
							thread(`t${i}`, `2026-10-${10 + i}T00:00:00Z`),
						),
					],
				},
			],
			["t0"],
		);
		const out = threadSections(sections.y, statusFrom({}));
		expect(out.list[0]?.chat.id).toBe("t0");
		expect(out.settled.map((r) => r.chat.id)).not.toContain("t0");
	});
});

describe("recentSections with Y projects", () => {
	it("leaves a plain project's chats in plain, Y² chats out of threads", () => {
		const out = recentSections([
			{ project: alpha, chats: [y2(), thread("a1")] },
			{ project: beta, chats: [thread("b1")] },
		]);
		expect(out.y.map((r) => r.chat.id)).toEqual(["a1"]);
		expect(out.plain.map((r) => r.chat.id)).toEqual(["b1"]);
		expect(out.y2.map((r) => r.chat.id)).toEqual(["y2"]);
	});
});

describe("y2NeedsYouLabel", () => {
	it("pluralises", () => {
		expect(y2NeedsYouLabel(1)).toBe("1 thread needs you");
		expect(y2NeedsYouLabel(2)).toBe("2 threads need you");
	});
});
