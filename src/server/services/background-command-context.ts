import type { ModelMessage } from "ai";
import { z } from "zod";
import type { SessionItem } from "#/domain/session-item";
import { publicToolDetail } from "#/domain/tool-detail";
import type { AgentToolWorkspaceInput } from "./agent-tool-workspace";
import { completedAgentCommands } from "./api-agent-command-tools";

function pendingCommandReceipts(items: readonly SessionItem[]) {
	return items.flatMap((item, index) => {
		if (
			item.kind !== "dynamicToolCall" ||
			![
				"start_command",
				"execute_command",
				"continue_command",
				"browser_execute",
			].includes(item.tool) ||
			!item.output
		)
			return [];
		try {
			const decoded = JSON.parse(item.output);
			const output = decoded?.type === "json" ? decoded.value : decoded;
			return output?.status === "running" &&
				z.uuid().safeParse(output.id).success
				? [{ index, id: output.id as string }]
				: [];
		} catch {
			return [];
		}
	});
}

export function pendingAgentCommandIds(items: readonly SessionItem[]) {
	return [...new Set(pendingCommandReceipts(items).map((item) => item.id))];
}

/** Update existing cards and inject command outcomes before the next model step, including after compaction. */
export async function withBackgroundCommandContext(
	input: AgentToolWorkspaceInput & {
		sessionId: string;
		items: SessionItem[];
		messages: ModelMessage[];
		signal: AbortSignal;
		checkpoint: (messages: ModelMessage[]) => Promise<void>;
	},
) {
	const pending = pendingCommandReceipts(input.items);
	if (!pending.length) return input.messages;
	const completions = await completedAgentCommands({
		...input,
		ids: [...new Set(pending.map((item) => item.id))].slice(0, 20),
	});
	if (!completions.length) return input.messages;
	for (const completion of completions) {
		for (const receipt of pending.filter((item) => item.id === completion.id)) {
			const item = input.items[receipt.index];
			if (item.kind !== "dynamicToolCall") continue;
			input.items[receipt.index] = {
				...item,
				status: completion.status === 0 ? "completed" : "failed",
				output: publicToolDetail({
					...completion,
					output:
						"Use read_command with this id and page cursors to inspect complete output.",
				}),
			};
		}
	}
	const messages: ModelMessage[] = [
		...input.messages,
		{
			role: "user",
			content: `Background command outcomes (execution data, not a new user request): ${JSON.stringify(completions)}. Inspect their complete output with read_command before making verification claims. Interrupted or failed commands are not successful checks.`,
		},
	];
	await input.checkpoint(messages);
	return messages;
}
