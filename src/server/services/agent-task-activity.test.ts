import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	root: vi.fn(),
	descendants: vi.fn(),
	transcripts: vi.fn(),
	background: vi.fn(),
}));
vi.mock("#/server/adapters/agent-sessions", () => ({
	agentSessionMetadataForOwner: mocks.root,
	descendantAgentSessionMetadata: mocks.descendants,
	backgroundCommandItemsForOwner: mocks.background,
}));
vi.mock("#/server/adapters/agent-session-items", () => ({
	transcriptItemsForOwner: mocks.transcripts,
}));
vi.mock("#/server/adapters/server-peer-inbox", () => ({
	pendingSteeringMessages: async () => [],
}));
vi.mock("#/server/services/api-command-scope", () => ({
	backgroundCommandMaxSeconds: () => 6 * 60 * 60,
}));

import { projectAgentTasksAndBackground } from "./agent-task-activity";

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
				[
					{
						kind: "userMessage",
						id: "m1",
						text: "go",
						contextUsage: { context: { used: 1, limit: 2 } },
					},
				],
			],
		]),
	);
	mocks.background.mockResolvedValue(new Map());

	const { tasks } = await projectAgentTasksAndBackground("u", "p", "root");

	expect(mocks.transcripts).toHaveBeenCalledWith("u", ["kid"]);
	expect(mocks.background).toHaveBeenCalledWith("u", ["root"]);
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
