import { expect, it, vi } from "vitest";
import {
	archiveModelContext,
	readModelContextArchive,
	searchModelContextArchives,
} from "./context-archives";

const storage = vi.hoisted(() => ({
	upload: vi.fn(),
	download: vi.fn(),
	list: vi.fn(),
}));
vi.mock("./checkpoints/storage", () => ({
	uploadCheckpoint: storage.upload,
	downloadCheckpoint: storage.download,
	listContextArchives: storage.list,
	checkpointObjectPrefix: (user: string, session: string) =>
		`${user}/${session}/`,
}));

it("roundtrips canonical reasoning in the encrypted owner/chat-scoped archive", async () => {
	const messages = [
		{
			role: "assistant" as const,
			content: [
				{
					type: "reasoning" as const,
					text: "",
					providerOptions: { anthropic: { redactedData: "opaque" } },
				},
			],
		},
	];
	const reference = await archiveModelContext("alice", "chat", messages);
	expect(storage.upload).toHaveBeenCalledWith(
		"alice",
		"chat",
		reference,
		JSON.stringify({ version: 1, messages }),
	);
	storage.download.mockResolvedValue(storage.upload.mock.calls[0][3]);
	expect(await readModelContextArchive("alice", "chat", reference)).toEqual(
		messages,
	);
	expect(storage.download).toHaveBeenCalledWith(
		"alice",
		"chat",
		`alice/chat/${reference}.enc`,
	);
	const count = storage.download.mock.calls.length;
	await expect(
		readModelContextArchive("alice", "chat", "../bob/other"),
	).rejects.toThrow();
	expect(storage.download).toHaveBeenCalledTimes(count);
});

it("ranks across an archive page and resumes by result position rather than original message index", async () => {
	const reference = "context-00000000-0000-0000-0000-000000000002";
	storage.list.mockResolvedValue([reference]);
	storage.download.mockResolvedValue(
		JSON.stringify({
			version: 1,
			messages: [
				...Array.from({ length: 12 }, (_, i) => ({
					role: "assistant",
					content: `worker ${i}`,
				})),
				{ role: "assistant", content: "worker isolation" },
			],
		}),
	);
	const signal = new AbortController().signal;
	const first = await searchModelContextArchives(
		"alice",
		"chat",
		"worker isolation",
		0,
		signal,
	);
	expect(first.matches[0].messageIndex).toBe(12);
	if (first.nextOffset === null)
		throw new Error("Expected another result page");
	const second = await searchModelContextArchives(
		"alice",
		"chat",
		"worker isolation",
		first.nextOffset,
		signal,
		first.nextMessageOffset,
	);
	expect(
		[...first.matches, ...second.matches].map((match) => match.messageIndex),
	).toEqual([12, ...Array.from({ length: 12 }, (_, i) => i)]);
	expect(second.nextOffset).toBeNull();
});

it("searches scoped archives and paginates within a dense archive without losing matches", async () => {
	const reference = "context-00000000-0000-0000-0000-000000000001";
	storage.list.mockResolvedValue([reference]);
	storage.download.mockResolvedValue(
		JSON.stringify({
			version: 1,
			messages: Array.from({ length: 14 }, (_, i) => ({
				role: "assistant",
				content: `decision ${i}`,
			})),
		}),
	);
	const signal = new AbortController().signal;
	const first = await searchModelContextArchives(
		"alice",
		"chat",
		"decision",
		0,
		signal,
	);
	expect(first.matches).toHaveLength(10);
	expect(first.nextOffset).toBe(0);
	expect(first.nextMessageOffset).toBe(10);
	const second = await searchModelContextArchives(
		"alice",
		"chat",
		"decision",
		0,
		signal,
		10,
	);
	expect(second.matches).toHaveLength(4);
	expect(second.matches[0].messageIndex).toBe(10);
	expect(second.nextOffset).toBeNull();
	expect(storage.list).toHaveBeenCalledWith("alice", "chat", 0, 3);
});

it("ranks evidence across archives and keeps each original scope pointer", async () => {
	const references = [
		"context-00000000-0000-0000-0000-000000000003",
		"context-00000000-0000-0000-0000-000000000004",
	];
	storage.list.mockResolvedValue(references);
	storage.download.mockImplementation(async (_owner, _chat, path: string) =>
		JSON.stringify({
			version: 1,
			messages: [
				{
					role: "assistant",
					content: path.includes(references[1]) ? "worker isolation" : "worker",
				},
			],
		}),
	);
	const result = await searchModelContextArchives(
		"alice",
		"chat",
		"worker isolation",
		0,
		new AbortController().signal,
	);
	expect(result.matches.map((match) => match.reference)).toEqual([
		references[1],
		references[0],
	]);
	expect(result.matches.every((match) => match.messageIndex === 0)).toBe(true);
});
