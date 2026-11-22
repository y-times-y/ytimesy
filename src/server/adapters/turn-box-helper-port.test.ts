import { describe, expect, it, vi } from "vitest";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

import type { ApiTurn } from "./api-turns";
import {
	helperMemoryPort,
	helperStepPort,
	settleHelperReport,
} from "./turn-box-helper-port";

const turn = { id: "t1", user_id: "u1", session_id: "h1" } as ApiTurn;
const helper = {
	id: "h1",
	userId: "u1",
	projectId: "p1",
	parentSessionId: "root",
	agentRole: "writer",
	providerRef: "vm-h",
} as never;
const owner = (chat: unknown) => (async () => chat) as never;

describe("helper port: a box's helper reaches only its own chat", () => {
	it("counts steps and reads usage for the turn's own helper, refuses a root chat", async () => {
		const counted: string[] = [];
		const deps = {
			owner: owner(helper),
			recordStep: (async (id: string) => {
				counted.push(id);
				return { steps: 3, budget: null };
			}) as never,
			descendantUsage: (async () => [{ id: "x" }]) as never,
		};
		expect(await helperStepPort(turn, { op: "record" }, deps)).toEqual({
			steps: 3,
			budget: null,
		});
		expect(counted).toEqual(["h1"]);
		expect(await helperStepPort(turn, { op: "descendantUsage" }, deps)).toEqual(
			[{ id: "x" }],
		);
		await expect(
			helperStepPort(
				turn,
				{ op: "record" },
				{
					...deps,
					owner: owner({ id: "r1", parentSessionId: null, agentRole: null }),
				},
			),
		).rejects.toBeInstanceOf(TurnBoxPortForbidden);
	});

	it("serves a helper's memory tools and recall built in each request", async () => {
		let built = 0;
		const memory = (async () => {
			built++;
			return {
				tools: { search_memory: { execute: async () => "hits" } },
				attach: async (messages: unknown[]) => ({ messages, recall: null }),
			};
		}) as never;
		const deps = { owner: owner(helper), memory };
		expect(await helperMemoryPort(turn, { op: "available" }, deps)).toBe(true);
		expect(
			await helperMemoryPort(
				turn,
				{ op: "tool", tool: "search_memory", input: { pattern: "x" } },
				deps,
			),
		).toBe("hits");
		expect(built).toBe(2);
	});
});

describe("a helper's report when its box turn settles", () => {
	const items = [
		{ kind: "userMessage", id: "u", text: "do it" },
		{ kind: "agentMessage", id: "a", text: "Did it." },
	] as never;
	it("a completed helper reports its final words, saves the result and queues the event", async () => {
		const saved: unknown[] = [];
		const queued: string[] = [];
		const summary = await settleHelperReport(
			turn,
			helper,
			{ state: "completed", items },
			{
				machines: () => ({}) as never,
				report: (async (input: { text: string; outcome: string }) =>
					`${input.outcome}: ${input.text}`) as never,
				save: (async (input: unknown) => {
					saved.push(input);
					return "e1";
				}) as never,
				enqueue: async (id) => {
					queued.push(id);
				},
			},
		);
		expect(summary).toBe("finished: Did it.");
		expect(saved).toEqual([
			{
				sessionId: "h1",
				turnId: "t1",
				eventType: "completed",
				summary: "finished: Did it.",
			},
		]);
		expect(queued).toEqual(["e1"]);
	});

	it("a failed helper reports the failure (budget exhaustion as such); a cancelled one and a root chat report nothing", async () => {
		const outcomes: string[] = [];
		const deps = {
			machines: () => ({}) as never,
			report: (async (input: { outcome: string; text: string }) => {
				outcomes.push(input.outcome);
				return input.text;
			}) as never,
			save: (async () => null) as never,
		};
		const failed = [
			...(items as unknown[]),
			{
				kind: "error",
				id: "e",
				message:
					"Budget exhausted (steps). The work so far was reported to the parent agent.",
			},
		] as never;
		const summary = await settleHelperReport(
			turn,
			helper,
			{ state: "failed", items: failed },
			deps,
		);
		expect(outcomes).toEqual(["budget exhausted"]);
		expect(summary).toContain("Budget exhausted (steps).");
		expect(summary).toContain("Did it.");
		expect(
			await settleHelperReport(
				turn,
				helper,
				{ state: "cancelled", items },
				deps,
			),
		).toBeNull();
		// A side chat is its own conversation: it never reports to Main.
		expect(
			await settleHelperReport(
				turn,
				{ ...(helper as object), agentBudget: { sideChat: true } } as never,
				{ state: "completed", items },
				deps,
			),
		).toBeNull();
		expect(
			await settleHelperReport(
				turn,
				{ id: "r1", parentSessionId: null } as never,
				{ state: "completed", items },
				deps,
			),
		).toBeNull();
	});
});
