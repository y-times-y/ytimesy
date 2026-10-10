import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	checkpointObjectPrefix,
	downloadCheckpoint,
	ensurePrivateCheckpointBucket,
	listContextArchives,
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
it("rejects a public bucket", async () => {
	vi.stubGlobal("fetch", async () => Response.json({ public: true }));
	await expect(ensurePrivateCheckpointBucket()).rejects.toThrow("private");
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
	await ensurePrivateCheckpointBucket();
	const archive = `context-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`;
	const path = await uploadCheckpoint("alice", "chat", archive, "payload");
	expect(await downloadCheckpoint("alice", "chat", path)).toBe("payload");
	expect(await listContextArchives("alice", "chat", 0, 3)).toEqual([archive]);
	await removeContextArchives("alice", "chat");
	expect(await listContextArchives("alice", "chat", 0, 3)).toEqual([]);
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllEnvs();
});
