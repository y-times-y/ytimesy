import type { ModelMessage } from "ai";
import { z } from "zod";

const capturedOutput = z
	.object({
		reference: z.uuid(),
		exitCode: z.number().int(),
		stopped: z.enum(["timeout", "output_limit"]).nullable(),
		stdout: z.string(),
		stderr: z.string(),
	})
	.catchall(z.json());
const outputPage = z
	.object({
		reference: z.uuid(),
		stream: z.enum(["stdout", "stderr"]),
		content: z.string(),
	})
	.catchall(z.json());

/** Retire only completed earlier turns, retaining receipts and exact archive recovery. */
export async function archiveEarlierToolOutput(
	messages: ModelMessage[],
	archive?: (messages: ModelMessage[]) => Promise<string>,
): Promise<ModelMessage[]> {
	if (!archive) return messages;
	let currentTurn = -1;
	for (let index = messages.length - 1; index >= 0; index--)
		if (messages[index].role === "user") {
			currentTurn = index;
			break;
		}
	if (currentTurn < 1) return messages;
	let completedTurn = -1;
	for (let index = currentTurn - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message.role === "assistant" &&
			(typeof message.content === "string"
				? message.content.trim().length > 0
				: message.content.some(
						(part) => part.type === "text" && part.text.trim(),
					) && !message.content.some((part) => part.type === "tool-call"))
		) {
			completedTurn = index;
			break;
		}
	}
	if (completedTurn < 1) return messages;
	let reference: string | undefined;
	const projected: ModelMessage[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (messageIndex >= completedTurn || message.role !== "tool") {
			projected.push(message);
			continue;
		}
		const content: typeof message.content = [];
		for (const part of message.content) {
			if (part.type !== "tool-result" || part.output.type !== "json") {
				content.push(part);
				continue;
			}
			const retire = async (value: unknown) => {
				const parsed =
					part.toolName === "read_tool_output"
						? outputPage.safeParse(value)
						: ["bash", "search_files", "list_files", "run_checks"].includes(
									part.toolName,
								)
							? capturedOutput.safeParse(value)
							: null;
				if (!parsed?.success || "archivedOutput" in parsed.data) return value;
				const fields =
					part.toolName === "read_tool_output"
						? ["content"]
						: ["stdout", "stderr"];
				const bodies = fields.filter(
					(field) =>
						typeof parsed.data[field] === "string" &&
						parsed.data[field].length >= 4096,
				);
				if (!bodies.length) return value;
				reference ??= await archive(messages);
				if (!reference) throw new Error("Output archive is unavailable.");
				const output: Record<string, z.infer<ReturnType<typeof z.json>>> = {
					...parsed.data,
				};
				const retired: Record<string, number> = {};
				for (const field of bodies) {
					const characters = Array.from(parsed.data[field] as string);
					retired[field] = characters.length;
					output[field] =
						`${characters.slice(0, 512).join("")}\n[Historical output omitted; recover the original from archivedOutput.]\n${characters.slice(-512).join("")}`;
				}
				output.archivedOutput = {
					reference,
					messageIndex,
					toolCallId: part.toolCallId,
					characters: retired,
					instruction:
						"Preview of an earlier turn, not complete or current evidence. Original exit, stop, source and pagination receipts are unchanged. Recover the exact tool result with read_context_archive before relying on omitted output; read_tool_output also retrieves the retained artifact while its VM exists.",
				};
				return output;
			};
			const value = part.output.value;
			let retired: unknown;
			try {
				if (part.toolName === "run_checks" && Array.isArray(value)) {
					const entries = [];
					for (const entry of value) entries.push(await retire(entry));
					retired = entries;
				} else retired = await retire(value);
			} catch {
				return messages;
			}
			const changed = Array.isArray(value)
				? Array.isArray(retired) &&
					retired.some((entry, index) => entry !== value[index])
				: retired !== value;
			if (!changed) {
				content.push(part);
				continue;
			}
			content.push({
				...part,
				output: { type: "json", value: z.json().parse(retired) },
			});
		}
		projected.push(
			content.every((part, index) => part === message.content[index])
				? message
				: { ...message, content },
		);
	}
	return reference ? projected : messages;
}
