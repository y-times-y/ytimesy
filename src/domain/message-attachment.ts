import { z } from "zod";

/** A file the user attached to a message. Bytes live in private storage. */
export type MessageAttachment = {
	readonly id: string;
	readonly name: string;
	readonly mediaType: string;
	readonly size: number;
};

export const MESSAGE_ATTACHMENT_LIMITS = {
	files: 8,
	fileBytes: 10 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
} as const;

/** Outside every checkout, so attachments are never committed. */
export const AGENT_ATTACHMENT_DIRECTORY = "/tmp/ytimesy-attachments";

export const VIEWABLE_IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export const messageAttachment = z.object({
	id: z.string().uuid(),
	name: z.string().min(1).max(120),
	mediaType: z.string().min(1).max(120),
	size: z.number().int().positive().max(MESSAGE_ATTACHMENT_LIMITS.fileBytes),
});

/** One path segment: no separators, control characters or leading dots. */
export function safeAttachmentName(name: string) {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base
		.normalize("NFC")
		.replace(/[^\p{L}\p{N}._ -]/gu, "_")
		.replace(/^[.\s]+/, "")
		.trim()
		.slice(0, 120);
	return cleaned || "attachment";
}

export function attachmentPath(
	attachment: Pick<MessageAttachment, "id" | "name">,
) {
	return `${AGENT_ATTACHMENT_DIRECTORY}/${attachment.id}/${attachment.name}`;
}

export function isViewableImage(mediaType: string) {
	return (VIEWABLE_IMAGE_TYPES as readonly string[]).includes(mediaType);
}

function sizeLabel(bytes: number) {
	return bytes < 1024 * 1024
		? `${Math.max(1, Math.round(bytes / 1024))} KB`
		: `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the model reads: where each attached file is and how to inspect it. */
export function withAttachmentNote(
	text: string,
	attachments: readonly MessageAttachment[] | undefined,
) {
	if (!attachments?.length) return text;
	const lines = attachments.map(
		(attachment) =>
			`- ${attachmentPath(attachment)} (${attachment.mediaType}, ${sizeLabel(attachment.size)})`,
	);
	const images = attachments.some((attachment) =>
		isViewableImage(attachment.mediaType),
	);
	return `${text}\n\nThe user attached ${attachments.length === 1 ? "a file" : "files"}, saved on your machine:\n${lines.join("\n")}${images ? "\nLook at each attached image with view_image (pass the absolute path) before acting on it." : ""}`;
}

/** Base64 file bytes as the browser sends them, before storage. */
export const incomingAttachments = z
	.array(
		z.object({
			name: z.string().min(1).max(255),
			mediaType: z.string().max(120),
			base64: z
				.string()
				.min(1)
				.max(Math.ceil(MESSAGE_ATTACHMENT_LIMITS.fileBytes / 3) * 4)
				.regex(/^[A-Za-z0-9+/]+={0,2}$/),
		}),
	)
	.max(MESSAGE_ATTACHMENT_LIMITS.files)
	.refine(
		(files) =>
			files.reduce((total, file) => total + base64ByteLength(file.base64), 0) <=
			MESSAGE_ATTACHMENT_LIMITS.totalBytes,
		"Attached files exceed 20 MB in total.",
	);

export type IncomingAttachment = z.infer<typeof incomingAttachments>[number];

export function base64ByteLength(base64: string) {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

/** Keep a well-formed declared type; images are re-detected from their bytes on the server. */
export function declaredMediaType(value: string) {
	const type = value.trim().toLowerCase();
	return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(
		type,
	)
		? type
		: "application/octet-stream";
}
