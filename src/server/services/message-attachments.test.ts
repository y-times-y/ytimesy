import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { attachmentPath } from "#/domain/message-attachment";

const stored = new Map<string, string>();
vi.mock("../adapters/checkpoints/storage", () => ({
	uploadMessageAttachment: async (
		_user: string,
		_session: string,
		id: string,
		base64: string,
	) => {
		stored.set(id, base64);
	},
	downloadMessageAttachment: async (
		_user: string,
		_session: string,
		id: string,
	) => {
		const base64 = stored.get(id);
		if (base64 === undefined) throw new Error("missing");
		return base64;
	},
}));

const {
	materializeMessageAttachments,
	pastedTextContent,
	sessionAttachments,
	storeMessageAttachments,
} = await import("./message-attachments");

const run = promisify(execFile);
const host = {
	exec: async (_vm: unknown, command: string) => {
		try {
			const { stdout, stderr } = await run("bash", ["-c", command]);
			return { stdout, stderr, exitCode: 0 };
		} catch (error) {
			const failed = error as {
				stdout?: string;
				stderr?: string;
				code?: number;
			};
			return {
				stdout: failed.stdout ?? "",
				stderr: failed.stderr ?? "",
				exitCode: failed.code ?? 1,
			};
		}
	},
	writeTextFile: async (_vm: unknown, path: string, contents: string) =>
		writeFile(path, contents),
} as unknown as Parameters<typeof materializeMessageAttachments>[0];
const written: string[] = [];

afterAll(async () => {
	for (const path of written) await rm(path, { recursive: true, force: true });
});

describe("message attachments on the machine", () => {
	it("stores files under fresh ids, detects images and keeps names distinct", async () => {
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
			"base64",
		);
		const attachments = await storeMessageAttachments("user", "session", [
			{
				name: "shot.png",
				mediaType: "text/plain",
				base64: png.toString("base64"),
			},
			{
				name: "shot.png",
				mediaType: "",
				base64: Buffer.from("hi").toString("base64"),
			},
		]);
		expect(attachments[0]).toMatchObject({
			name: "shot.png",
			mediaType: "image/png",
		});
		expect(attachments[1]).toMatchObject({
			name: "2-shot.png",
			mediaType: "application/octet-stream",
			size: 2,
		});
		expect(new Set(attachments.map((attachment) => attachment.id)).size).toBe(
			2,
		);
	});

	it("writes exact bytes once and restores files a rebuilt machine lost", async () => {
		const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13]);
		const [attachment] = await storeMessageAttachments("user", "session", [
			{ name: "data.bin", mediaType: "", base64: bytes.toString("base64") },
		]);
		const items = [
			{
				kind: "userMessage" as const,
				id: "m" as never,
				text: "see",
				attachments: [attachment],
			},
		];
		expect(sessionAttachments(items)).toEqual([attachment]);
		const vm = WorkspaceId("vm");
		const path = attachmentPath(attachment);
		written.push(path.slice(0, path.lastIndexOf("/")));
		await materializeMessageAttachments(host, vm, "user", "session", [
			attachment,
		]);
		expect(await readFile(path)).toEqual(bytes);
		stored.delete(attachment.id);
		// Present files are not downloaded again.
		await materializeMessageAttachments(host, vm, "user", "session", [
			attachment,
		]);
		await rm(path);
		stored.set(attachment.id, bytes.toString("base64"));
		await materializeMessageAttachments(host, vm, "user", "session", [
			attachment,
		]);
		expect(await readFile(path)).toEqual(bytes);
	});

	it("stores and writes an empty file", async () => {
		const [attachment] = await storeMessageAttachments("user", "session", [
			{ name: "empty.txt", mediaType: "text/plain", base64: "" },
		]);
		expect(attachment).toMatchObject({ size: 0, mediaType: "text/plain" });
		const path = attachmentPath(attachment);
		written.push(path.slice(0, path.lastIndexOf("/")));
		await materializeMessageAttachments(
			host,
			WorkspaceId("vm"),
			"user",
			"session",
			[attachment],
		);
		expect(await readFile(path)).toEqual(Buffer.alloc(0));
	});
});

describe("pasted text attachments", () => {
	it("sends a large paste as a text file the agent is told to read", async () => {
		const { pastedTextFile } = await import(
			"#/features/sessions/pasted-text-chip"
		);
		const { withAttachmentNote } = await import("#/domain/message-attachment");
		const text = Array.from(
			{ length: 84 },
			(_, index) => `line ${index} — ünïcode`,
		).join("\n");
		const file = pastedTextFile(text, 1);
		expect(file).toMatchObject({ name: "pasted-1.txt", type: "text/plain" });
		// What encodeAttachments sends for this file.
		const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
		const [attachment] = await storeMessageAttachments("user", "session", [
			{ name: file.name, mediaType: file.type, base64 },
		]);
		expect(attachment).toMatchObject({
			name: "pasted-1.txt",
			mediaType: "text/plain",
			lines: 84,
		});
		const path = attachmentPath(attachment);
		written.push(path.slice(0, path.lastIndexOf("/")));
		await materializeMessageAttachments(
			host,
			WorkspaceId("vm"),
			"user",
			"session",
			[attachment],
		);
		expect(await readFile(path, "utf8")).toBe(text);
		const note = withAttachmentNote("Summarize this", [attachment]);
		expect(note).toContain(`${path} (pasted text, 84 lines`);
		expect(note).toContain("Read it in full before acting on it.");
		expect(await pastedTextContent("user", "session", attachment)).toBe(text);
	});

	it("does not count lines or serve previews for other files", async () => {
		const [attachment] = await storeMessageAttachments("user", "session", [
			{
				name: "notes.txt",
				mediaType: "text/plain",
				base64: Buffer.from("a\nb").toString("base64"),
			},
		]);
		expect(attachment).not.toHaveProperty("lines");
		await expect(
			pastedTextContent("user", "session", attachment),
		).rejects.toThrow();
	});
});
