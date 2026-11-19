import type { ModelMessage } from "ai";
import { z } from "zod";
import {
	AGENT_ATTACHMENT_DIRECTORY,
	isViewableImage,
	type MessageAttachment,
} from "./message-attachment";

export const Y_SQUARED_VIEW_IMAGE_TOOL = "view_image";
/** Largest image Y² looks at: there is no image library to scale one down. */
export const Y_SQUARED_IMAGE_BYTES = 3_000_000;
/** Most attachments one start_thread / message_thread forwards. */
export const Y_SQUARED_FORWARD_LIMIT = 4;
/** Starts the text part of a viewed image's result: what the history strip looks for. */
export const Y_SQUARED_IMAGE_MARK = "Attached image ";

export const Y_SQUARED_VIEW_IMAGE_DESCRIPTION =
	"Look at an image the person attached to a message in THIS chat (PNG, JPEG, GIF or WebP, up to 3 MB). Pass the attachment's name (or its id). Returns the picture itself. Nothing else can be viewed. Never describe an attached image you did not view.";
export const viewImageInput = z.object({
	attachment: z
		.string()
		.min(1)
		.max(400)
		.describe("The attachment's name or id (an old-style path also works)"),
});
export const forwardAttachmentsField = z
	.array(z.string().min(1).max(400))
	.max(Y_SQUARED_FORWARD_LIMIT)
	.optional()
	.describe(
		"Names or ids of files the person attached in THIS chat, to pass on with the message (at most 4)",
	);

/** The attachment a name, id or old-style path points at, among this chat's own. */
export function findAttachment(
	attachments: readonly MessageAttachment[],
	reference: string,
) {
	const ref = reference.trim();
	const byId = attachments.find((a) => a.id === ref);
	if (byId) return byId;
	const base = ref.startsWith(AGENT_ATTACHMENT_DIRECTORY + "/")
		? ref.slice(AGENT_ATTACHMENT_DIRECTORY.length + 1)
		: ref;
	const [first, ...rest] = base.split("/");
	if (rest.length && first) {
		const byPath = attachments.find(
			(a) => a.id === first && a.name === rest.join("/"),
		);
		if (byPath) return byPath;
	}
	// The newest one wins when two messages reuse a name.
	return [...attachments].reverse().find((a) => a.name === base);
}

const LINE =
	/^- \/tmp\/ytimesy-attachments\/[0-9a-f-]{36}\/(.+) \((.+), (empty|[\d.]+ (?:KB|MB))\)$/;

/**
 * withAttachmentNote's note, as Y² reads it: each file named, no path (Y² has no
 * machine), images pointing at view_image.
 */
export function ySquaredAttachmentNote(text: string) {
	const at = text.search(
		/\n\nThe user attached (?:a file|files), saved on your machine:\n/,
	);
	if (at < 0) return text;
	const notes: string[] = [];
	for (const line of text.slice(at).split("\n").slice(3)) {
		const match = LINE.exec(line);
		if (!match) continue;
		const [, name, kind = "", size] = match;
		const pasted = kind.startsWith("pasted text");
		notes.push(
			!pasted && isViewableImage(kind)
				? "The person attached " +
						name +
						" (image, " +
						size +
						"). Use " +
						Y_SQUARED_VIEW_IMAGE_TOOL +
						" to look at it."
				: "The person attached " +
						name +
						" (" +
						(pasted ? "pasted text" : kind) +
						", " +
						size +
						"); you cannot open it, only forward it with attachments.",
		);
	}
	return notes.length ? text.slice(0, at) + "\n\n" + notes.join("\n") : text;
}

/** Y²'s model input: user messages carry the Y² note. Idempotent. */
export function ySquaredModelMessages(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	return messages.map((message): ModelMessage => {
		if (message.role !== "user") return message;
		if (typeof message.content === "string") {
			const content = ySquaredAttachmentNote(message.content);
			return content === message.content ? message : { ...message, content };
		}
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "text"
					? { ...part, text: ySquaredAttachmentNote(part.text) }
					: part,
			),
		};
	});
}

export const viewedImageNote = (name: string) =>
	Y_SQUARED_IMAGE_MARK +
	name +
	" was viewed earlier; its pixels are not kept. Call view_image again to look at it again.";

/** A viewed image's bytes replaced by a short note: what is persisted, never the pixels. */
export function withoutViewedImages<T extends readonly ModelMessage[]>(
	messages: T,
): T {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "tool") return message;
		const content = message.content.map((part) => {
			if (
				part.type !== "tool-result" ||
				part.toolName !== Y_SQUARED_VIEW_IMAGE_TOOL ||
				part.output.type !== "content"
			)
				return part;
			const first = part.output.value[0];
			if (
				first?.type !== "text" ||
				!first.text.startsWith(Y_SQUARED_IMAGE_MARK) ||
				part.output.value.every((v) => v.type === "text")
			)
				return part;
			changed = true;
			const name =
				first.text.slice(Y_SQUARED_IMAGE_MARK.length).split(" (")[0] ?? "";
			return {
				...part,
				output: { type: "text" as const, value: viewedImageNote(name) },
			};
		});
		return { ...message, content } as ModelMessage;
	});
	return (changed ? next : messages) as unknown as T;
}
