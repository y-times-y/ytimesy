import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	checkpointObjectPrefix,
	downloadCheckpoint,
	listContextArchives,
	removeChatObjects,
	removeContextArchives,
	uploadCheckpoint,
} from "./storage";

vi.mock("#/server/auth/token-vault", () => ({
	seal: async (value: string) =>
		`encrypted:${Buffer.from(value).toString("base64")}`,
	unseal: async (value: string) =>
		Buffer.from(value.slice(10), "base64").toString(),
}));
beforeEach(() => {
	vi.stubEnv("SUPABASE_STORAGE_URL", "https://project.supabase.co");
	vi.stubEnv("SUPABASE_STORAGE_SERVICE_KEY", "server-secret");
});

it("lists archives with owner/chat scope and rejects returned traversal names", async () => {
	const fetch = vi.fn<typeof globalThis.fetch>(async () =>
		Response.json([{ name: "../other.enc" }]),
	);
	vi.stubGlobal("fetch", fetch);
	await expect(listContextArchives("alice", "chat", 3, 3)).rejects.toThrow(
		"Invalid context archive name",
	);
	expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({
		prefix: checkpointObjectPrefix("alice", "chat"),
		offset: 3,
		limit: 3,
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
it("encrypts before upload and rejects another owner's object before network access", async () => {
	vi.stubEnv("SUPABASE_STORAGE_URL", "https://project.supabase.co");
	vi.stubEnv("SUPABASE_STORAGE_SERVICE_KEY", "server-secret");
	let body = "";
	const fetch = vi.fn(async (_url: string, options?: RequestInit) => {
		if (options?.method === "POST") body = String(options.body);
		return new Response(options?.method === "POST" ? "{}" : body);
	});
	vi.stubGlobal("fetch", fetch);
	const path = await uploadCheckpoint(
		"alice",
		"session",
		"revision",
		"private code",
	);
	expect(body).not.toContain("private code");
	expect(await downloadCheckpoint("alice", "session", path)).toBe(
		"private code",
	);
	const calls = fetch.mock.calls.length;
	await expect(downloadCheckpoint("bob", "session", path)).rejects.toThrow(
		"ownership",
	);
	expect(fetch).toHaveBeenCalledTimes(calls);
	expect(path.startsWith(checkpointObjectPrefix("alice", "session"))).toBe(
		true,
	);
});

it("deletes only context archives in the authorized chat prefix", async () => {
	const name = "context-00000000-0000-0000-0000-000000000001.enc";
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(Response.json([{ name }]))
		.mockResolvedValueOnce(Response.json({}))
		.mockResolvedValueOnce(Response.json([]));
	vi.stubGlobal("fetch", fetch);
	await removeContextArchives("alice", "chat");
	expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
		prefix: checkpointObjectPrefix("alice", "chat"),
		search: "context-",
	});
	expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
		prefixes: [`${checkpointObjectPrefix("alice", "chat")}${name}`],
	});
});

it("stops archive deletion if storage returns a name outside the context namespace", async () => {
	const fetch = vi.fn(async () => Response.json([{ name: "../other.enc" }]));
	vi.stubGlobal("fetch", fetch);
	await expect(removeContextArchives("alice", "chat")).rejects.toThrow(
		"deletion stopped",
	);
	expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps isolated evaluation checkpoints on local disk without contacting storage", async () => {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-checkpoints-"));
	vi.stubEnv("YTIMESY_HARNESS_EVALUATION_ENABLED", "1");
	vi.stubEnv("YTIMESY_EVALUATION_CHECKPOINT_DIR", directory);
	const fetch = vi.fn<typeof globalThis.fetch>();
	vi.stubGlobal("fetch", fetch);
	const archive = `context-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
	const path = await uploadCheckpoint("alice", "chat", archive, "payload");
	expect(await downloadCheckpoint("alice", "chat", path)).toBe("payload");
	expect(await listContextArchives("alice", "chat", 0, 3)).toEqual([archive]);
	await removeContextArchives("alice", "chat");
	expect(await listContextArchives("alice", "chat", 0, 3)).toEqual([]);
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllEnvs();
});

it("deletes a chat's checkpoints, archives, attachments and recovery points, and nothing else", async () => {
	const chat = checkpointObjectPrefix("alice", "chat");
	const listings: Record<string, string[][]> = {
		[chat]: [["rev-1.enc", "context-a.enc"], []],
		[`attachments/${chat}`]: [["0f.enc"], []],
		[`points/${chat}`]: [["conversation-point-m1.enc"], []],
	};
	const deleted: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			const body = JSON.parse(String(options?.body ?? "{}"));
			if (url.endsWith("/object/list/ytimesy-checkpoints"))
				return Response.json(
					(listings[body.prefix].shift() ?? []).map((name) => ({ name })),
				);
			deleted.push(...body.prefixes);
			return Response.json({});
		}),
	);
	await removeChatObjects("alice", "chat");
	expect(deleted).toEqual([
		`${chat}rev-1.enc`,
		`${chat}context-a.enc`,
		`attachments/${chat}0f.enc`,
		`points/${chat}conversation-point-m1.enc`,
	]);
});

it("stops deleting when a listing returns a nested or traversal name", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json([{ name: "../other.enc" }])),
	);
	await expect(removeChatObjects("alice", "chat")).rejects.toThrow(
		"deletion stopped",
	);
});

it("stores checkpoints compressed and still reads ones stored before compression", async () => {
	const stored = new Map<string, string>();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") {
				stored.set(url, String(options.body));
				return Response.json({});
			}
			const body = stored.get(url);
			return body === undefined
				? new Response("", { status: 404 })
				: new Response(body);
		}),
	);
	const payload = JSON.stringify(
		Array.from({ length: 400 }, (_, index) => ({
			role: "user",
			content: `message ${index}: the same words again and again`,
		})),
	);
	const path = await uploadCheckpoint("alice", "chat", "rev-9", payload);
	expect(await downloadCheckpoint("alice", "chat", path)).toBe(payload);
	// Several times smaller than the payload, encryption and all.
	expect([...stored.values()][0]?.length).toBeLessThan(payload.length / 3);
	// A recovery point goes under the expiring prefix, readable only by its owner.
	const point = await uploadCheckpoint(
		"alice",
		"chat",
		"conversation-point-m1",
		payload,
		{ expiring: true },
	);
	expect(point.startsWith("points/")).toBe(true);
	expect(await downloadCheckpoint("alice", "chat", point)).toBe(payload);
	await expect(downloadCheckpoint("mallory", "chat", point)).rejects.toThrow(
		"ownership",
	);
	// An object from before compression (the payload as it is).
	const { seal } = await import("#/server/auth/token-vault");
	const legacy = `${checkpointObjectPrefix("alice", "chat")}old.enc`;
	stored.set(
		[...stored.keys()][0]?.replace(/rev-9\.enc$/, "old.enc") as string,
		await seal(
			JSON.stringify({ userId: "alice", sessionId: "chat", payload: "plain" }),
		),
	);
	expect(await downloadCheckpoint("alice", "chat", legacy)).toBe("plain");
});
