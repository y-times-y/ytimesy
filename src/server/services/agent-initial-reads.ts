import { randomUUID } from "node:crypto";
import type { ModelMessage, ToolSet } from "ai";
import { z } from "zod";
import type { ApiAgentEvent } from "#/domain/api-agent-event";

/** Execute the existing authorized read tools before the first inference, not a model-authored plan or a substitute for reading. */
export async function prefetchInitialAgentReads(input: {
	messages: ModelMessage[];
	tools: ToolSet;
	coordination: boolean;
	signal: AbortSignal;
	onEvent: (event: ApiAgentEvent) => Promise<void>;
}): Promise<ModelMessage[]> {
	if (input.messages.length !== 1 || input.messages[0].role !== "user")
		return input.messages;
	if (typeof input.tools.read_repository_guidance?.execute !== "function")
		return input.messages;
	const requests = [
		{ name: "read_repository_guidance", arguments: { scope: "." } },
		{ name: "read_environment_report", arguments: {} },
		...(input.coordination
			? [{ name: "read_task_capacity", arguments: {} }]
			: []),
	];
	const results = await Promise.all(
		requests.map(async (request) => {
			const execute = input.tools[request.name]?.execute;
			if (typeof execute !== "function") return null;
			input.signal.throwIfAborted();
			const id = `call_prefetch_${randomUUID().replaceAll("-", "")}`;
			await input.onEvent({
				type: "tool-call",
				id,
				name: request.name,
				input: request.arguments,
			});
			const value = await execute(request.arguments, {
				toolCallId: id,
				messages: input.messages,
				abortSignal: input.signal,
				context: {},
			});
			input.signal.throwIfAborted();
			const output = z.json().parse(value);
			await input.onEvent({
				type: "tool-result",
				id,
				name: request.name,
				output,
			});
			return { id, name: request.name, arguments: request.arguments, output };
		}),
	);
	input.signal.throwIfAborted();
	const reads = results.filter((result) => result !== null);
	return [
		...input.messages,
		{
			role: "assistant",
			content: reads.map((read) => ({
				type: "tool-call",
				toolCallId: read.id,
				toolName: read.name,
				input: read.arguments,
			})),
		},
		{
			role: "tool",
			content: reads.map((read) => ({
				type: "tool-result",
				toolCallId: read.id,
				toolName: read.name,
				output: { type: "json", value: read.output },
			})),
		},
	];
}
