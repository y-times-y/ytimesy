import type { ModelMessage } from "ai";
import { z } from "zod";

const guidancePacket = z
	.object({ referencedDocuments: z.array(z.json()) })
	.catchall(z.json());
const completeDocument = z
	.object({
		path: z.string(),
		sha256: z.string(),
		content: z.string().min(16_001),
		nextStart: z.null(),
	})
	.catchall(z.json());

const implementationDecisions = new Set([
	"create_task",
	"launch_ready_tasks",
	"apply_patches",
	"apply_patch",
	"replace_text",
	"create_file",
]);
type ArchivedGuidanceBody = {
	reference: string;
	messageIndex: number;
	toolCallId: string;
	characters: number;
	instruction: string;
};

/** Keep guidance during investigation; a later completed implementation/delegation decision permits recoverable archival. */
export async function archiveConsumedGuidance(
	messages: ModelMessage[],
	archive?: (messages: ModelMessage[]) => Promise<string>,
): Promise<ModelMessage[]> {
	if (!archive) return messages;
	const lastDecision = messages.reduce(
		(last, message, index) =>
			message.role === "tool" &&
			message.content.some(
				(part) =>
					part.type === "tool-result" &&
					!part.toolCallId.startsWith("call_prefetch_") &&
					part.output.type !== "error-text" &&
					part.output.type !== "error-json" &&
					implementationDecisions.has(part.toolName),
			)
				? index
				: last,
		-1,
	);
	let reference: string | undefined;
	const archivedDocuments = new Map<string, ArchivedGuidanceBody>();
	const projected: ModelMessage[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "tool" || messageIndex >= lastDecision) {
			projected.push(message);
			continue;
		}
		const content: typeof message.content = [];
		for (const part of message.content) {
			if (
				part.type !== "tool-result" ||
				part.toolName !== "read_repository_guidance" ||
				part.output.type !== "json"
			) {
				content.push(part);
				continue;
			}
			const packet = guidancePacket.safeParse(part.output.value);
			if (!packet.success) {
				content.push(part);
				continue;
			}
			const documents = [];
			let changed = false;
			for (const entry of packet.data.referencedDocuments) {
				const document = completeDocument.safeParse(entry);
				if (!document.success) {
					documents.push(entry);
					continue;
				}
				reference ??= await archive(messages);
				const { content: body, ...metadata } = document.data;
				const archivedBody = {
					reference,
					messageIndex,
					toolCallId: part.toolCallId,
					characters: Array.from(body).length,
					instruction:
						"Previously supplied complete body, now archived without summarization; archiving does not undo that reading. A fresh read_repository_guidance verifies its current hash without replaying an unchanged body. Recover exact text with search_context_history/read_context_archive or reread this path when a specific detail has been forgotten. This receipt is not the body or current checkout proof.",
				};
				archivedDocuments.set(
					JSON.stringify([metadata.path, metadata.sha256]),
					archivedBody,
				);
				documents.push({ ...metadata, archivedBody });
				changed = true;
			}
			content.push(
				changed
					? {
							...part,
							output: {
								type: "json" as const,
								value: { ...packet.data, referencedDocuments: documents },
							},
						}
					: part,
			);
		}
		projected.push({ ...message, content });
	}
	if (!reference) return messages;
	return projected.map((message) => {
		if (message.role !== "tool") return message;
		const content = message.content.map((part) => {
			if (
				part.type !== "tool-result" ||
				part.toolName !== "read_repository_guidance" ||
				part.output.type !== "json"
			)
				return part;
			const packet = guidancePacket.safeParse(part.output.value);
			if (!packet.success) return part;
			return {
				...part,
				output: {
					type: "json" as const,
					value: {
						...packet.data,
						referencedDocuments: packet.data.referencedDocuments.map(
							(entry) => {
								if (
									!entry ||
									typeof entry !== "object" ||
									Array.isArray(entry) ||
									entry.alreadyInContext !== true ||
									entry.nextStart !== null
								)
									return entry;
								const archivedBody = archivedDocuments.get(
									JSON.stringify([entry.path, entry.sha256]),
								);
								if (!archivedBody) return entry;
								const { alreadyInContext: _consumed, ...metadata } = entry;
								return { ...metadata, previouslyRead: true, archivedBody };
							},
						),
					},
				},
			};
		});
		return content.every((part, index) => part === message.content[index])
			? message
			: { ...message, content };
	});
}
