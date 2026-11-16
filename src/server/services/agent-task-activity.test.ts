import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	root: vi.fn(),
	descendants: vi.fn(),
	transcripts: vi.fn(),
	background: vi.fn(),
	revisions: vi.fn(async () => new Map([["kid", "4"]])),
	since: vi.fn(),
	kinds: vi.fn(async (): Promise<Map<string, unknown[]>> => new Map()),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: mocks.root,
	descendantAgentSessionMetadata: mocks.descendants,
	backgroundCommandItemsForOwner: mocks.background,
	itemsRevisionsForOwner: mocks.revisions,
	itemRowsSinceForOwner: mocks.since,
	agentSessionItemsOfKindsForOwner: mocks.kinds,
}));
vi.mock("#/server/adapters/agent-session-items", () => ({
	transcriptPagesForOwner: mocks.transcripts,
}));
vi.mock("#/server/adapters/server-peer-inbox", () => ({
	pendingSteeringMessages: async () => [],
}));
vi.mock("#/server/services/api-command-scope", () => ({
	backgroundCommandMaxSeconds: () => 6 * 60 * 60,
}));

import { HELPER_OLDER_PAGE, HELPER_PAGE } from "#/domain/child-task-activity";
import {
	olderHelperItems,
	projectAgentTasksAndBackground,
} from "./agent-task-activity";

const base = {
	userId: "u",
	projectId: "p",
	workspaceId: "w",
	harness: "api",
	listedModelId: null,
	turnStatus: "idle",
	createdAt: "2026-11-05T10:00:00.000Z",
	updatedAt: "2026-11-05T10:05:00.000Z",
};

it("reads Main's background items only and the transcripts of the shown subagents only", async () => {
	mocks.root.mockResolvedValue({
		...base,
		id: "root",
		parentSessionId: null,
		title: "Main",
	});
	mocks.descendants.mockResolvedValue([
		{
			...base,
			id: "kid",
			parentSessionId: "root",
			title: "Kid",
			agentRole: "researcher",
			agentBudget: { steps: 10, minutes: 10, tokens: 1000 },
		},
		{
			...base,
			id: "side",
			parentSessionId: "root",
			title: "Side",
			agentRole: "writer",
			agentBudget: { sideChat: true },
		},
		{ ...base, id: "old", parentSessionId: "root", title: "Retired" },
	]);
	mocks.transcripts.mockResolvedValue(
		new Map([
			[
				"kid",
				{
					first: 0,
					items: [
						{
							kind: "userMessage",
							id: "m1",
							text: "go",
							contextUsage: { context: { used: 1, limit: 2 } },
						},
					],
				},
			],
		]),
	);
	mocks.background.mockResolvedValue(new Map());

	const { tasks } = await projectAgentTasksAndBackground("u", "p", "root");

	// The last page of each, never the whole transcript.
	expect(mocks.transcripts).toHaveBeenCalledWith("u", ["kid"], HELPER_PAGE);
	// Background commands from their own rows: a page can leave one out.
	expect(mocks.background).toHaveBeenCalledWith("u", ["root", "kid"]);
	expect(tasks.map((task) => task.id)).toEqual(["kid"]);
	expect(tasks[0]?.items).toHaveLength(1);
});

it("shows nothing for a chat of another project", async () => {
	mocks.root.mockResolvedValue({
		...base,
		id: "root",
		projectId: "other",
		parentSessionId: null,
		title: "Main",
	});
	mocks.descendants.mockResolvedValue([]);
	expect(await projectAgentTasksAndBackground("u", "p", "root")).toEqual({
		tasks: [],
		background: {},
	});
});

it("does not read a finished helper's transcript the browser already holds", async () => {
	mocks.root.mockResolvedValue({
		...base,
		id: "root",
		parentSessionId: null,
		title: "Main",
	});
	mocks.descendants.mockResolvedValue([
		{
			...base,
			id: "kid",
			parentSessionId: "root",
			title: "Kid",
			agentRole: "researcher",
			agentBudget: { steps: 10, minutes: 10, tokens: 1000 },
		},
	]);
	mocks.transcripts.mockResolvedValue(
		new Map([["kid", { first: 0, items: [] }]]),
	);
	mocks.background.mockResolvedValue(new Map());
	mocks.transcripts.mockClear();
	const { tasks } = await projectAgentTasksAndBackground("u", "p", "root", {
		kid: "4",
	});
	expect(mocks.transcripts).toHaveBeenCalledWith("u", [], HELPER_PAGE);
	expect(tasks).toEqual([
		expect.objectContaining({ id: "kid", itemsRev: "4", unchanged: true }),
	]);
	// A revision the browser does not hold is read again.
	mocks.transcripts.mockClear();
	const again = await projectAgentTasksAndBackground("u", "p", "root", {
		kid: "3",
	});
	expect(mocks.transcripts).toHaveBeenCalledWith("u", ["kid"], HELPER_PAGE);
	expect(again.tasks[0]).toMatchObject({ itemsRev: "4" });
	expect(again.tasks[0]?.unchanged).toBeUndefined();
});

describe("a helper still working", () => {
	const setup = () => {
		mocks.root.mockResolvedValue({
			...base,
			id: "root",
			parentSessionId: null,
			title: "Main",
		});
		mocks.descendants.mockResolvedValue([
			{
				...base,
				id: "kid",
				parentSessionId: "root",
				title: "Kid",
				turnStatus: "running",
				agentRole: "researcher",
				agentBudget: { steps: 10, minutes: 10, tokens: 1000 },
			},
		]);
		mocks.revisions.mockResolvedValue(new Map([["kid", "9"]]));
		// Its last page starts at stored position 5.
		mocks.transcripts.mockResolvedValue(
			new Map([
				[
					"kid",
					{
						first: 5,
						items: [
							{ kind: "agentMessage", id: "a", text: "one" },
							{ kind: "agentMessage", id: "b", text: "two" },
						],
					},
				],
			]),
		);
		mocks.background.mockResolvedValue(new Map());
		mocks.transcripts.mockClear();
		mocks.since.mockReset();
	};

	it("sends only the rows written since the revision the page holds", async () => {
		setup();
		mocks.since.mockResolvedValue(
			new Map([
				[
					"kid",
					{
						itemsRev: "9",
						count: 3,
						rows: [
							{
								position: 2,
								item: { kind: "agentMessage", id: "c", text: "three" },
							},
						],
					},
				],
			]),
		);
		mocks.kinds.mockResolvedValueOnce(
			new Map([
				[
					"kid",
					[
						{
							kind: "userMessage",
							id: "a",
							text: "go",
							apiUsage: { inputTokens: 100, outputTokens: 20 },
							contextUsage: { usedTokens: 50, contextWindow: 1000 },
						},
					],
				],
			]),
		);
		const { tasks } = await projectAgentTasksAndBackground(
			"u",
			"p",
			"root",
			{ kid: "7" },
			{ deltas: true },
		);
		// No transcript is read; spend and context use come from the turns' starts.
		expect(mocks.transcripts).toHaveBeenCalledWith("u", [], HELPER_PAGE);
		expect(tasks[0]).toMatchObject({
			id: "kid",
			items: [],
			itemsRev: "9",
			itemsDelta: {
				base: "7",
				count: 3,
				rows: [{ position: 2, item: { id: "c" } }],
			},
		});
		expect(mocks.kinds).toHaveBeenCalledWith(
			"u",
			["kid"],
			["userMessage", "notice"],
		);
		expect(tasks[0]?.subagent?.spend.tokens).toBe(120);
		expect(tasks[0]?.itemPositions).toBeUndefined();
	});

	it("reads its last page, with stored positions, when asked fresh, when the page has no copy, or when the delta is not small", async () => {
		setup();
		const whole = async (
			known: Record<string, string>,
			mode: { deltas: boolean; fresh?: boolean },
		) => {
			mocks.transcripts.mockClear();
			const { tasks } = await projectAgentTasksAndBackground(
				"u",
				"p",
				"root",
				known,
				mode,
			);
			expect(mocks.transcripts).toHaveBeenCalledWith("u", ["kid"], HELPER_PAGE);
			expect(tasks[0]?.itemsDelta).toBeUndefined();
			return tasks[0];
		};
		mocks.since.mockResolvedValue(
			new Map([["kid", { itemsRev: "9", count: 3, rows: [] }]]),
		);
		const fresh = await whole({ kid: "7" }, { deltas: true, fresh: true });
		expect(fresh?.itemPositions).toEqual([5, 6]);
		// Older items load on demand.
		expect(fresh?.itemsFrom).toBe(5);
		expect(fresh?.subagent).toBeDefined();
		// Spend and context use from the turns' starts, not from the page.
		expect(mocks.kinds).toHaveBeenLastCalledWith(
			"u",
			["kid"],
			["userMessage", "notice"],
		);
		await whole({}, { deltas: true });
		// More rows than a delta is worth, or none to compare against.
		mocks.since.mockResolvedValue(
			new Map([
				[
					"kid",
					{
						itemsRev: "9",
						count: 2,
						rows: [
							{ position: 0, item: {} },
							{ position: 1, item: {} },
						],
					},
				],
			]),
		);
		await whole({ kid: "7" }, { deltas: true });
		mocks.since.mockResolvedValue(new Map());
		await whole({ kid: "7" }, { deltas: true });
		// A page that does not take deltas never gets them, and no positions.
		mocks.since.mockClear();
		const old = await projectAgentTasksAndBackground("u", "p", "root", {
			kid: "7",
		});
		expect(mocks.since).not.toHaveBeenCalled();
		expect(old.tasks[0]?.itemPositions).toBeUndefined();
		expect(old.tasks[0]?.itemsFrom).toBeUndefined();
	});

	it("answers each helper its own way: a delta where it fits, a page for one the browser does not hold", async () => {
		setup();
		mocks.descendants.mockResolvedValue([
			{
				...base,
				id: "kid",
				parentSessionId: "root",
				title: "Kid",
				turnStatus: "running",
				agentRole: "researcher",
				agentBudget: { steps: 10, minutes: 10, tokens: 1000 },
			},
			{
				...base,
				id: "new",
				parentSessionId: "root",
				title: "New",
				turnStatus: "running",
				agentRole: "researcher",
				agentBudget: { steps: 10, minutes: 10, tokens: 1000 },
				createdAt: "2026-11-05T10:01:00.000Z",
			},
		]);
		mocks.revisions.mockResolvedValue(
			new Map([
				["kid", "9"],
				["new", "2"],
			]),
		);
		mocks.since.mockResolvedValue(
			new Map([
				[
					"kid",
					{
						itemsRev: "9",
						count: 8,
						rows: [
							{
								position: 7,
								item: { kind: "agentMessage", id: "c", text: "three" },
							},
						],
					},
				],
			]),
		);
		mocks.transcripts.mockResolvedValue(
			new Map([
				[
					"new",
					{ first: 0, items: [{ kind: "agentMessage", id: "n", text: "hi" }] },
				],
			]),
		);
		const { tasks } = await projectAgentTasksAndBackground(
			"u",
			"p",
			"root",
			{ kid: "7" },
			{ deltas: true },
		);
		// A new helper no longer makes every working helper travel again.
		expect(mocks.since).toHaveBeenCalledWith("u", { kid: "7" });
		expect(mocks.transcripts).toHaveBeenCalledWith("u", ["new"], HELPER_PAGE);
		expect(tasks.find((task) => task.id === "kid")).toMatchObject({
			itemsDelta: { base: "7", count: 8 },
		});
		expect(tasks.find((task) => task.id === "new")).toMatchObject({
			items: [{ id: "n" }],
			itemPositions: [0],
		});
		expect(tasks.find((task) => task.id === "new")?.itemsFrom).toBeUndefined();
	});
});

it("reads a helper's older page before the position the view starts at, with stored positions", async () => {
	mocks.root.mockResolvedValue({
		...base,
		id: "kid",
		parentSessionId: "root",
		title: "Kid",
	});
	mocks.transcripts.mockResolvedValue(
		new Map([
			[
				"kid",
				{
					first: 2,
					items: [
						{ kind: "agentMessage", id: "a", text: "one" },
						{
							kind: "agentMessage",
							id: "hidden",
							text: "\u2063ytimesy-child-event:x",
						},
						{ kind: "agentMessage", id: "b", text: "two" },
					],
				},
			],
		]),
	);
	expect(await olderHelperItems("u", "p", "kid", 5)).toEqual({
		items: [
			{ kind: "agentMessage", id: "a", text: "one" },
			{ kind: "agentMessage", id: "b", text: "two" },
		],
		itemPositions: [2, 4],
		itemsFrom: 2,
	});
	expect(mocks.transcripts).toHaveBeenLastCalledWith("u", ["kid"], {
		...HELPER_OLDER_PAGE,
		before: 5,
	});
	// Not a helper of this project: nothing is read.
	mocks.transcripts.mockClear();
	mocks.root.mockResolvedValue({
		...base,
		id: "kid",
		projectId: "other",
		parentSessionId: "root",
	});
	expect(await olderHelperItems("u", "p", "kid", 5)).toBeNull();
	mocks.root.mockResolvedValue({ ...base, id: "kid", parentSessionId: null });
	expect(await olderHelperItems("u", "p", "kid", 5)).toBeNull();
	expect(mocks.transcripts).not.toHaveBeenCalled();
});
