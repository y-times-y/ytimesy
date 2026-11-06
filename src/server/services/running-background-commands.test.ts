import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ items: vi.fn() }));
vi.mock("#/server/adapters/agent-sessions", () => ({
	backgroundCommandItemsForOwner: mocks.items,
}));
vi.mock("#/server/services/api-command-scope", () => ({
	backgroundCommandMaxSeconds: () => 6 * 60 * 60,
}));

import { runningBackgroundCommandsByChat } from "./running-background-commands";

const started = (id: string, at: number) => ({
	id: `call-${id}`,
	kind: "dynamicToolCall",
	tool: "bash",
	status: "completed",
	background: { id, label: `run ${id}`, startedAt: at },
});

it("reads only the background items of all the chats in one query and reports the running ones", async () => {
	const now = Date.now();
	mocks.items.mockResolvedValue(
		new Map([
			[
				"chat-a",
				[
					started("one", now - 10_000),
					{
						...started("two", now - 20_000),
						background: {
							id: "two",
							label: "run two",
							startedAt: now - 20_000,
							exitCode: 0,
						},
					},
				],
			],
		]),
	);
	const result = await runningBackgroundCommandsByChat("owner", [
		"chat-a",
		"chat-b",
		"chat-a",
	]);
	expect(mocks.items).toHaveBeenCalledOnce();
	expect(mocks.items).toHaveBeenCalledWith("owner", ["chat-a", "chat-b"]);
	expect(Object.keys(result)).toEqual(["chat-a", "chat-b"]);
	expect(result["chat-a"]?.map((command) => command.id)).toEqual(["one"]);
	expect(result["chat-b"]).toEqual([]);
});
