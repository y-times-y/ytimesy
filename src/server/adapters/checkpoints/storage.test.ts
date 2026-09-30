import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	checkpointObjectPrefix,
	downloadCheckpoint,
	ensurePrivateCheckpointBucket,
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
