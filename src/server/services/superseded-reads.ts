import type { ModelMessage } from "ai";
import { z } from "zod";

const completePage = z
	.object({
		path: z.string(),
		start: z.literal(0),
		content: z.string(),
		nextStart: z.null(),
	})
	.catchall(z.json());
const completeBatchEntry = z
	.object({
		path: z.string(),
		content: z.string(),
		truncated: z.literal(false),
	})
	.catchall(z.json());

/** Preserve call/result pairing and the latest complete body; archive exact prior evidence. */
export async function archiveSupersededReads(
	messages: ModelMessage[],
	archive?: (messages: ModelMessage[]) => Promise<string>,
): Promise<ModelMessage[]> {
	if (!archive) return messages;
	const lastRead = new Map<string, number>();
	const entries = (name: string, value: unknown) => {
		if (name === "read_file") {
			const page = completePage.safeParse(value);
			return page.success ? [page.data] : [];
		}
		if (name !== "read_files" || !Array.isArray(value)) return [];
		return value.flatMap((entry) => {
			const parsed = completeBatchEntry.safeParse(entry);
			return parsed.success ? [parsed.data] : [];
		});
	};
	for (const [index, message] of messages.entries()) {
		if (message.role !== "tool") continue;
		for (const part of message.content)
			if (part.type === "tool-result" && part.output.type === "json")
				for (const entry of entries(part.toolName, part.output.value))
					lastRead.set(entry.path, index);
	}
	let reference: string | undefined;
	const projected: ModelMessage[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (message.role !== "tool") {
			projected.push(message);
			continue;
		}
		const content: typeof message.content = [];
		for (const part of message.content) {
			if (part.type !== "tool-result" || part.output.type !== "json") {
				content.push(part);
				continue;
			}
			const superseded = entries(part.toolName, part.output.value).filter(
				(entry) =>
					entry.content.length >= 4096 &&
					(lastRead.get(entry.path) ?? -1) > messageIndex,
			);
			if (!superseded.length) {
				content.push(part);
				continue;
			}
			try {
				reference ??= await archive(messages);
			} catch {
				return messages;
			}
			const retire = (
				entry:
					| z.infer<typeof completeBatchEntry>
					| z.infer<typeof completePage>,
			) => {
				const { content: body, ...metadata } = entry;
				return {
					...metadata,
					archivedBody: {
						reference: reference as string,
						messageIndex,
						toolCallId: part.toolCallId,
						characters: Array.from(body).length,
						instruction:
							"Historical body superseded by a later complete read of this path. Recover exact earlier evidence with read_context_archive. Neither this receipt nor the later read proves current checkout contents; reread before editing.",
					},
				};
			};
			const value =
				part.toolName === "read_file"
					? retire(superseded[0])
					: (part.output.value as z.infer<ReturnType<typeof z.json>>[]).map(
							(entry) => {
								const parsed = completeBatchEntry.safeParse(entry);
								return parsed.success &&
									superseded.some((old) => old.path === parsed.data.path)
									? retire(parsed.data)
									: entry;
							},
						);
			content.push({ ...part, output: { type: "json", value } });
		}
		projected.push(
			content.every((part, index) => part === message.content[index])
				? message
				: { ...message, content },
		);
	}
	return reference ? projected : messages;
}
