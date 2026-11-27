import { describe, expect, it, vi } from "vitest";
import type { MessageAttachment } from "#/domain/message-attachment";
import { withAttachmentNote } from "#/domain/message-attachment";
import type { SessionItem } from "#/domain/session-item";
import { ySquaredInstructions } from "#/domain/y-squared";
import {
	findAttachment,
	withoutViewedImages,
	ySquaredAttachmentNote,
	ySquaredModelMessages,
} from "#/domain/y-squared-images";
import { ySquaredTools } from "./y-squared-tools";

// A 1x1 PNG.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const img: MessageAttachment = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "shot.png",
	mediaType: "image/png",
	size: 70,
};
const big: MessageAttachment = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "big.png",
	mediaType: "image/png",
	size: 4_000_000,
};
const doc: MessageAttachment = {
	id: "33333333-3333-4333-8333-333333333333",
	name: "a.pdf",
	mediaType: "application/pdf",
	size: 2048,
};
const items = [
	{ kind: "userMessage", id: "m1", text: "hi", attachments: [img, big, doc] },
] as unknown as SessionItem[];

function setup(extra: Record<string, unknown> = {}) {
	const download = vi.fn(async () => PNG);
	const send = vi.fn(async () => ({ turnStatus: "running" }));
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "self",
		machines: {} as never,
		modelId: "m",
		harnessId: "api" as never,
		items: () => items,
		deps: {
			download,
			send,
			crew: () => null,
			metadata: async () =>
				({
					id: "t1",
					projectId: "p",
					harness: "api",
					turnStatus: "idle",
					title: "T",
				}) as never,
			...extra,
		},
	});
	const call = (name: string, args: unknown) =>
		(
			tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
		).execute(args, {});
	return { tools, call, download, send };
}

describe("Y² view_image", () => {
	it("returns only the image part, for this chat's attachment", async () => {
		const { tools, call, download } = setup();
		const out = await call("view_image", { attachment: "shot.png" });
		expect(download).toHaveBeenCalledWith("u", "self", img.id);
		const model = await (tools.view_image as any).toModelOutput({
			output: out,
		});
		expect(model.type).toBe("content");
		expect(model.value.map((p: { type: string }) => p.type)).toEqual([
			"text",
			"file",
		]);
		expect(model.value[1].mediaType).toBe("image/png");
		expect(model.value[0].text).not.toContain(PNG);
		const byId = await call("view_image", { attachment: img.id });
		expect(byId).toMatchObject({ name: "shot.png" });
		const byPath = await call("view_image", {
			attachment: "/tmp/ytimesy-attachments/" + img.id + "/shot.png",
		});
		expect(byPath).toMatchObject({ name: "shot.png" });
	});
	it("refuses unknown, other-chat, non-image and over-3 MB without a read", async () => {
		const { call, download } = setup();
		expect(await call("view_image", { attachment: "nope.png" })).toContain(
			"No attachment",
		);
		expect(await call("view_image", { attachment: "/etc/passwd" })).toContain(
			"No attachment",
		);
		expect(await call("view_image", { attachment: "a.pdf" })).toContain(
			"cannot be viewed",
		);
		expect(await call("view_image", { attachment: "big.png" })).toContain(
			"3.8 MB",
		);
		expect(download).not.toHaveBeenCalled();
	});
	it("refuses bytes that are not an image", async () => {
		const { call } = setup({ download: async () => "aGVsbG8gd29ybGQ=" });
		expect(await call("view_image", { attachment: "shot.png" })).toContain(
			"does not hold",
		);
	});
});

describe("Y² forwarding attachments", () => {
	it("start_thread passes this chat's files as the message's attachments", async () => {
		const { call, send, download } = setup();
		await call("start_thread", {
			title: "T",
			brief: "do it",
			attachments: ["shot.png", img.id],
		});
		expect(download).toHaveBeenCalledTimes(1);
		const sent = send.mock.calls[0] as unknown as [
			unknown,
			unknown,
			{ attachments: unknown[] },
		];
		expect(sent[2].attachments).toEqual([
			{ name: "shot.png", mediaType: "image/png", base64: PNG },
		]);
	});
	it("message_thread forwards and refuses a file of another chat", async () => {
		const { call, send } = setup();
		await call("message_thread", {
			id: "t1",
			text: "see",
			attachments: ["a.pdf"],
		});
		expect(send).toHaveBeenCalledTimes(1);
		const refused = await call("message_thread", {
			id: "t1",
			text: "see",
			attachments: ["other.png"],
		});
		expect(refused).toContain("Not sent");
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("Y² attachment note and history", () => {
	const note = withAttachmentNote("look", [img, doc]);
	it("names the files and never a path", () => {
		const text = ySquaredAttachmentNote(note);
		expect(text).toContain(
			"The person attached shot.png (image, 1 KB). Use view_image to look at it.",
		);
		expect(text).toContain("a.pdf");
		expect(text).not.toContain("/tmp");
		expect(text).not.toContain("saved on your machine");
		expect(text.startsWith("look")).toBe(true);
		expect(ySquaredAttachmentNote(text)).toBe(text);
		expect(ySquaredModelMessages([{ role: "user", content: note }])[0]).toEqual(
			{
				role: "user",
				content: text,
			},
		);
	});
	it("findAttachment matches names, ids, paths", () => {
		expect(findAttachment([img], "shot.png")).toBe(img);
		expect(findAttachment([img], "x/../shot.png")).toBeUndefined();
	});
	it("strips viewed pixels from history and nothing else", () => {
		const messages = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c",
						toolName: "view_image",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "Attached image shot.png (1 KB)" },
								{
									type: "file",
									data: { type: "data", data: PNG },
									mediaType: "image/png",
								},
							],
						},
					},
				],
			},
		] as never;
		const out = JSON.stringify(withoutViewedImages(messages));
		expect(out).not.toContain(PNG);
		expect(out).toContain("viewed earlier");
		const builder = [
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c",
						toolName: "view_image",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "Image a.png (sha256 x)" },
								{
									type: "file",
									data: { type: "data", data: PNG },
									mediaType: "image/png",
								},
							],
						},
					},
				],
			},
		] as never;
		expect(withoutViewedImages(builder)).toBe(builder);
	});
	it("instructions tell Y² to view and forward", () => {
		const text = ySquaredInstructions();
		expect(text).toContain("view_image");
		expect(text).toContain("attachments");
		expect(text).toContain(
			"never describe or act on an image you did not view",
		);
	});
});

describe("Y²'s model input drops old reasoning, so a changed prompt never meets a stale thinking block", () => {
	const reasoning = (text: string) => ({
		type: "reasoning" as const,
		text,
		providerOptions: { anthropic: { signature: "sig" } },
	});
	const history = [
		{ role: "user" as const, content: "What is going on?" },
		{
			role: "assistant" as const,
			content: [
				reasoning("old thinking"),
				{ type: "text" as const, text: "Two threads working." },
			],
		},
		{ role: "user" as const, content: "And now?" },
		{
			role: "assistant" as const,
			content: [
				reasoning("this turn's thinking"),
				{
					type: "tool-call" as const,
					toolCallId: "t1",
					toolName: "threads",
					input: {},
				},
			],
		},
		{
			role: "tool" as const,
			content: [
				{
					type: "tool-result" as const,
					toolCallId: "t1",
					toolName: "threads",
					output: { type: "text" as const, value: "ok" },
				},
			],
		},
	];
	const parts = (
		messages: ReturnType<typeof ySquaredModelMessages>,
		index: number,
	) => {
		const content = messages[index].content;
		return Array.isArray(content) ? content.map((p) => p.type) : [];
	};

	it("removes reasoning from assistant messages before the latest user message", () => {
		const out = ySquaredModelMessages(history);
		expect(parts(out, 1)).toEqual(["text"]);
	});

	it("keeps the current turn's reasoning: a tool loop needs it", () => {
		const out = ySquaredModelMessages(history);
		expect(parts(out, 3)).toEqual(["reasoning", "tool-call"]);
	});

	it("is idempotent and leaves user and tool messages alone", () => {
		const once = ySquaredModelMessages(history);
		expect(ySquaredModelMessages(once)).toEqual(once);
		expect(once[0]).toEqual(history[0]);
		expect(once[4]).toEqual(history[4]);
	});

	it("an assistant message that was only reasoning is dropped, not left empty", () => {
		const out = ySquaredModelMessages([
			{ role: "user", content: "a" },
			{ role: "assistant", content: [reasoning("only")] },
			{ role: "user", content: "b" },
		]);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("changing Y²'s prompt does not matter to old history: the same input whatever the instructions", () => {
		// The stored history is what is resent; nothing in it carries the instructions.
		expect(JSON.stringify(ySquaredModelMessages(history))).not.toContain(
			"old thinking",
		);
	});
});
