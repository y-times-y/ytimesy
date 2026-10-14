import { describe, expect, it } from "vitest";
import { apiConversation } from "./api-conversation";
import {
	attachmentPath,
	base64ByteLength,
	declaredMediaType,
	incomingAttachments,
	MESSAGE_ATTACHMENT_LIMITS,
	safeAttachmentName,
	withAttachmentNote,
} from "./message-attachment";
import { sessionItemsQueuedWithUser } from "./session-item";

const image = {
	id: "0f8fad5b-d9cb-469f-a165-70867728950e",
	name: "screen shot.png",
	mediaType: "image/png",
	size: 2048,
};

describe("message attachments", () => {
	it("keeps names to one safe path segment", () => {
		expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
		expect(safeAttachmentName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
		expect(safeAttachmentName(".env")).toBe("env");
		expect(safeAttachmentName("a$b`c;d.txt")).toBe("a_b_c_d.txt");
		expect(safeAttachmentName("...")).toBe("attachment");
		expect(safeAttachmentName("résumé.png")).toBe("résumé.png");
	});

	it("tells the model where each file is and to look at images", () => {
		const note = withAttachmentNote("Fix this layout", [image]);
		expect(note).toContain(attachmentPath(image));
		expect(note).toContain("view_image");
		const text = { ...image, name: "log.txt", mediaType: "text/plain" };
		expect(withAttachmentNote("Why?", [text])).not.toContain("view_image");
		expect(withAttachmentNote("Plain", [])).toBe("Plain");
	});

	it("rebuilds the note from items when history is reconstructed", () => {
		const items = sessionItemsQueuedWithUser(
			[],
			"Fix this layout",
			"m1",
			undefined,
			[image],
		);
		expect(items.at(-1)).toMatchObject({ attachments: [image] });
		const [message] = apiConversation(items);
		expect(String(message.content)).toContain(attachmentPath(image));
	});

	it("queues a repeated text when it brings new files", () => {
		const first = sessionItemsQueuedWithUser([], "Look", "m1");
		expect(sessionItemsQueuedWithUser(first, "Look", "m1")).toHaveLength(1);
		expect(
			sessionItemsQueuedWithUser(first, "Look", "m2", undefined, [image]),
		).toHaveLength(2);
	});

	it("enforces count, size and encoding limits", () => {
		const file = (bytes: number) => ({
			name: "a.bin",
			mediaType: "application/octet-stream",
			base64: Buffer.alloc(bytes).toString("base64"),
		});
		expect(incomingAttachments.safeParse([file(10)]).success).toBe(true);
		expect(
			incomingAttachments.safeParse(
				Array.from({ length: MESSAGE_ATTACHMENT_LIMITS.files + 1 }, () =>
					file(1),
				),
			).success,
		).toBe(false);
		expect(
			incomingAttachments.safeParse([
				file(MESSAGE_ATTACHMENT_LIMITS.fileBytes + 3),
			]).success,
		).toBe(false);
		expect(
			incomingAttachments.safeParse([
				file(9 * 1024 * 1024),
				file(9 * 1024 * 1024),
				file(9 * 1024 * 1024),
			]).success,
		).toBe(false);
		expect(
			incomingAttachments.safeParse([{ ...file(3), base64: "not base64!" }])
				.success,
		).toBe(false);
		expect(base64ByteLength(Buffer.from("abcd").toString("base64"))).toBe(4);
	});

	it("accepts only well-formed declared types", () => {
		expect(declaredMediaType("Application/PDF")).toBe("application/pdf");
		expect(declaredMediaType("")).toBe("application/octet-stream");
		expect(declaredMediaType("text/html; charset=utf-8")).toBe(
			"application/octet-stream",
		);
	});
});
