import type { ModelMessage } from "ai";
import { beforeEach, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import { completedAgentCommands } from "./api-agent-command-tools";
import { withBackgroundCommandContext } from "./background-command-context";

vi.mock("./api-agent-command-tools", () => ({
	completedAgentCommands: vi.fn(),
}));
const commandId = "b6794616-ec28-4390-831f-7d3ddf9f8621";
const receipt = (output: object): SessionItem => ({
	kind: "dynamicToolCall",
	id: SessionItemId("command-card"),
	tool: "start_command",
	status: "completed",
	output: JSON.stringify(output),
});
beforeEach(() => vi.resetAllMocks());

it("does not resolve a workspace or checkpoint without valid pending commands", async () => {
	const workspace = vi.fn();
	const checkpoint = vi.fn();
	const messages: ModelMessage[] = [];
	expect(
		await withBackgroundCommandContext({
			workspace,
			sessionId: "owner",
			items: [receipt({ id: "../other", status: "running" })],
			messages,
			signal: new AbortController().signal,
			checkpoint,
		}),
	).toBe(messages);
	expect(completedAgentCommands).not.toHaveBeenCalled();
	expect(workspace).not.toHaveBeenCalled();
	expect(checkpoint).not.toHaveBeenCalled();
});

it.each([0, 2, "interrupted"] as const)(
	"checkpoints outcome %s in its existing card even after history compaction",
	async (status) => {
		vi.mocked(completedAgentCommands).mockResolvedValue([
			{ id: commandId, status, stopped: null },
		]);
		const items = [
			receipt({ type: "json", value: { id: commandId, status: "running" } }),
		];
		const checkpoint = vi.fn(async () => {
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				id: "command-card",
				status: status === 0 ? "completed" : "failed",
			});
		});
		const input = {
			workspace: vi.fn(),
			sessionId: "owner",
			items,
			messages: [] as ModelMessage[],
			signal: new AbortController().signal,
			checkpoint,
		};
		const messages = await withBackgroundCommandContext(input);
		expect(checkpoint).toHaveBeenCalledWith(messages);
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages)).toContain("not successful checks");
		expect(JSON.stringify(messages)).toContain(commandId);
		await withBackgroundCommandContext({ ...input, messages });
		expect(completedAgentCommands).toHaveBeenCalledTimes(1);
		expect(checkpoint).toHaveBeenCalledTimes(1);
	},
);

it.each(["execute_command", "continue_command"])(
	"tracks yielded %s commands across durable restart",
	async (tool) => {
		vi.mocked(completedAgentCommands).mockResolvedValue([
			{ id: commandId, status: 0, stopped: null },
		]);
		const items = [{ ...receipt({ id: commandId, status: "running" }), tool }];
		const checkpoint = vi.fn();
		await withBackgroundCommandContext({
			workspace: vi.fn(),
			sessionId: "owner",
			items,
			messages: [],
			signal: new AbortController().signal,
			checkpoint,
		});
		expect(items[0]).toMatchObject({ status: "completed" });
		expect(checkpoint).toHaveBeenCalledOnce();
	},
);

it("leaves still-running commands unchanged without inventing completion", async () => {
	vi.mocked(completedAgentCommands).mockResolvedValue([]);
	const items = [receipt({ id: commandId, status: "running" })];
	const checkpoint = vi.fn();
	const messages: ModelMessage[] = [];
	expect(
		await withBackgroundCommandContext({
			workspace: vi.fn(),
			sessionId: "owner",
			items,
			messages,
			signal: new AbortController().signal,
			checkpoint,
		}),
	).toBe(messages);
	expect(items[0]).toMatchObject({
		output: expect.stringContaining("running"),
	});
	expect(checkpoint).not.toHaveBeenCalled();
});
