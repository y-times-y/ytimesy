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
	"apply_patches",
	"apply_patch",
	"replace_text",
	"create_file",
]);

/** Retain complete guidance through preflight; a completed implementation decision permits recoverable archival. */
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
					implementationDecisions.has(part.toolName),
			)
				? index
				: last,
		-1,
	);
	let reference: string | undefined;
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
				documents.push({
					...metadata,
					archivedBody: {
						reference,
						messageIndex,
						toolCallId: part.toolCallId,
						characters: Array.from(body).length,
						instruction:
							"Previously supplied complete body, now archived without summarization; archiving does not undo that reading. A fresh read_repository_guidance verifies its current hash without replaying an unchanged body. Recover exact text with search_context_history/read_context_archive or reread this path when a specific detail has been forgotten. This receipt is not the body or current checkout proof.",
					},
				});
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
	return reference ? projected : messages;
}
