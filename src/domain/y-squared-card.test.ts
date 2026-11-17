import { describe, expect, it } from "vitest";
import type { YOverviewThread } from "./y-overview";
import {
	CARD_DONE_LIMIT,
	CARD_DONE_WINDOW_MS,
	CARD_REQUEST_LIMIT,
	cardRequest,
	cardSignature,
	cardTicks,
	elapsedClock,
	ySquaredCard,
} from "./y-squared-card";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const chats: YOverviewThread[] = [
	{ id: "y2", title: "Y²", role: "y2", turnStatus: "completed" },
	{
		id: "old",
		title: "Old work",
		turnStatus: "completed",
		updatedAt: ago(3 * CARD_DONE_WINDOW_MS),
	},
	{
		id: "done",
		title: "Docs",
		turnStatus: "completed",
		updatedAt: ago(60_000),
	},
	{
		id: "run",
		title: "Fix login",
		turnStatus: "running",
		workingSince: ago(8 * 60_000),
		updatedAt: ago(1_000),
	},
	{
		id: "ask",
		title: "Billing",
		turnStatus: "completed",
		waitingOn: "plan",
		updatedAt: ago(120_000),
	},
	{
		id: "fail",
		title: "Import",
		turnStatus: "failed",
		waitingOn: "failed",
		updatedAt: ago(30_000),
	},
	{ id: "blank", title: "New chat", unused: true, updatedAt: ago(1_000) },
];

describe("ySquaredCard", () => {
	const card = ySquaredCard({
		chats,
		now: NOW,
		crew: [
			{
				sessionId: "run",
				lastRequest: "Fix the flaky login test",
				prUrl: null,
			},
			{
				sessionId: "done",
				lastRequest: "x".repeat(300),
				prUrl: "https://github.com/acme/web/pull/12",
			},
		],
	});

	it("puts what needs the person first, then working, then the recently done", () => {
		expect(card.waiting.map((t) => t.id)).toEqual(["fail", "ask"]);
		expect(card.working.map((t) => t.id)).toEqual(["run"]);
		expect(card.done.map((t) => t.id)).toEqual(["done"]);
	});

	it("leaves out Y², unused chats and threads done long ago", () => {
		const ids = [...card.waiting, ...card.working, ...card.done].map(
			(t) => t.id,
		);
		expect(ids).not.toContain("y2");
		expect(ids).not.toContain("blank");
		expect(ids).not.toContain("old");
	});

	it("carries the data a row shows: start time, request, what it waits on, PR", () => {
		expect(card.working[0]).toEqual({
			id: "run",
			title: "Fix login",
			status: "working",
			waitingOn: null,
			workingSince: NOW - 8 * 60_000,
			lastRequest: "Fix the flaky login test",
			prUrl: null,
			updatedAt: NOW - 1_000,
		});
		expect(card.waiting[1]).toMatchObject({
			status: "needs-you",
			waitingOn: "plan",
			workingSince: null,
		});
		expect(card.done[0]?.prUrl).toBe("https://github.com/acme/web/pull/12");
	});

	it("cuts the request to 120 characters and works without the crew", () => {
		expect(card.done[0]?.lastRequest?.length).toBe(CARD_REQUEST_LIMIT);
		expect(card.done[0]?.lastRequest?.endsWith("…")).toBe(true);
		expect(cardRequest("  a \n b  ")).toBe("a b");
		expect(cardRequest("")).toBeNull();
		const bare = ySquaredCard({ chats, now: NOW });
		expect(bare.working[0]?.lastRequest).toBeNull();
	});

	it("shows only the few most recent done threads", () => {
		const many = Array.from({ length: 8 }, (_, i) => ({
			id: `d${i}`,
			title: `Done ${i}`,
			turnStatus: "completed" as const,
			updatedAt: ago(i * 60_000 + 1_000),
		}));
		const shown = ySquaredCard({ chats: many, now: NOW }).done;
		expect(shown).toHaveLength(CARD_DONE_LIMIT);
		expect(shown[0]?.id).toBe("d0");
	});

	it("a running thread that also waits is working, not waiting", () => {
		const both = ySquaredCard({
			chats: [
				{
					id: "x",
					title: "X",
					turnStatus: "running",
					waitingOn: "question",
					workingSince: ago(1_000),
				},
			],
			now: NOW,
		});
		expect(both.working).toHaveLength(1);
		expect(both.waiting).toHaveLength(0);
	});
});

describe("elapsedClock", () => {
	it("counts from workingSince on the client's clock", () => {
		expect(elapsedClock(NOW - 5_000, NOW)).toBe("0:05");
		expect(elapsedClock(NOW - 8 * 60_000 - 7_000, NOW)).toBe("8:07");
		expect(elapsedClock(NOW - (3600 + 65) * 1000, NOW)).toBe("1:01:05");
		// a clock a little behind the server never shows a negative time
		expect(elapsedClock(NOW + 3_000, NOW)).toBe("0:00");
		expect(elapsedClock(null, NOW)).toBe("");
	});

	it("ticks forward second by second with no other input", () => {
		const since = NOW - 59_000;
		expect(elapsedClock(since, NOW)).toBe("0:59");
		expect(elapsedClock(since, NOW + 1_000)).toBe("1:00");
		expect(elapsedClock(since, NOW + 61_000)).toBe("2:00");
	});
});

describe("card refresh", () => {
	it("the crew is read again only when a row's status changes, never on time", () => {
		const a = cardSignature(chats);
		expect(cardSignature([...chats].reverse())).toBe(a);
		expect(cardSignature(chats.map((c) => ({ ...c, updatedAt: ago(5) })))).toBe(
			a,
		);
		const settled = chats.map((c) =>
			c.id === "run"
				? { ...c, turnStatus: "completed" as const, workingSince: null }
				: c,
		);
		expect(cardSignature(settled)).not.toBe(a);
		expect(cardSignature([])).toBe("");
	});

	it("the clock only ticks while something works", () => {
		expect(cardTicks(ySquaredCard({ chats, now: NOW }))).toBe(true);
		expect(
			cardTicks(
				ySquaredCard({ chats: chats.filter((c) => c.id !== "run"), now: NOW }),
			),
		).toBe(false);
	});
});
