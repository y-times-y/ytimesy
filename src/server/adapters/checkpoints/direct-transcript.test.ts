import { afterEach, beforeEach, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({
	seal: vi.fn(async (data: string) => `v2.sealed(${data})`),
	unseal: vi.fn(async (data: string) =>
		data.replace(/^v2\.sealed\((.*)\)$/, "$1"),
	),
}));
vi.mock("#/server/auth/token-vault", () => vault);

import {
	directTranscriptPath,
	directTranscriptStore,
} from "./direct-transcript";
import { checkpointObjectPrefix } from "./storage";

const CLAUDE = "11111111-2222-3333-4444-555555555555";
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const env = {
	R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
	R2_ACCESS_KEY_ID: "access",
	R2_SECRET_ACCESS_KEY: "secret",
	R2_CHECKPOINT_BUCKET: "ytimesy-checkpoints-test",
};

beforeEach(() => {
	vault.seal.mockClear();
	vault.unseal.mockClear();
	for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
	vi.stubEnv("YTIMESY_EVALUATION_CHECKPOINT_DIR", "");
	vi.stubEnv("YTIMESY_HARNESS_EVALUATION_ENABLED", "");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it("is unavailable without private R2 storage, and in isolated evaluations", () => {
	vi.stubEnv("R2_ACCOUNT_ID", "");
	vi.stubEnv("R2_ACCESS_KEY_ID", "");
	vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
	vi.stubEnv("R2_CHECKPOINT_BUCKET", "");
	expect(directTranscriptStore("u1", SESSION)).toBeUndefined();
	vi.stubEnv("R2_ACCOUNT_ID", env.R2_ACCOUNT_ID);
	vi.stubEnv("R2_ACCESS_KEY_ID", env.R2_ACCESS_KEY_ID);
	vi.stubEnv("R2_SECRET_ACCESS_KEY", env.R2_SECRET_ACCESS_KEY);
	vi.stubEnv("R2_CHECKPOINT_BUCKET", env.R2_CHECKPOINT_BUCKET);
	expect(directTranscriptStore("u1", SESSION)).toBeDefined();
	vi.stubEnv("YTIMESY_EVALUATION_CHECKPOINT_DIR", "/tmp/evaluation");
	vi.stubEnv("YTIMESY_HARNESS_EVALUATION_ENABLED", "1");
	expect(directTranscriptStore("u1", SESSION)).toBeUndefined();
});

it("prepares an upload: a private object path, a short-lived PUT URL and a wrapped key", async () => {
	const prepared = await directTranscriptStore("u1", SESSION)?.prepareUpload(
		CLAUDE,
	);
	const path = `${checkpointObjectPrefix("u1", SESSION)}claude-code-${CLAUDE}.direct`;
	expect(prepared?.path).toBe(path);
	expect(directTranscriptPath("u1", SESSION, CLAUDE)).toBe(path);
	const config = prepared?.config as Record<string, string>;
	const url = new URL(config.url);
	expect(url.origin).toBe(
		`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	);
	expect(url.pathname).toBe(`/${env.R2_CHECKPOINT_BUCKET}/${path}`);
	expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
	expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
	expect(Buffer.from(config.dataKey, "base64")).toHaveLength(32);
	expect(config.path).toBe(path);
	// The key travels wrapped in the object's header, bound to this user and path.
	expect(config.header).toBe(`v2.sealed(${config.dataKey})`);
	expect(vault.seal).toHaveBeenCalledWith(config.dataKey, {
		purpose: `claude-transcript-key:${path}`,
		userId: "u1",
	});
	// A fresh key every time.
	const again = await directTranscriptStore("u1", SESSION)?.prepareUpload(
		CLAUDE,
	);
	expect(again?.config.dataKey).not.toBe(config.dataKey);
	await expect(
		directTranscriptStore("u1", SESSION)?.prepareUpload("../x"),
	).rejects.toThrow("Invalid Claude Code session id.");
});

it("prepares a download from the object's header only", async () => {
	const path = directTranscriptPath("u1", SESSION, CLAUDE);
	const fetchMock = vi.fn(
		async () =>
			new Response(
				`YTDIRECT1\nv2.sealed(KEYBASE64)\n${"\u0000binary".repeat(10)}`,
				{ status: 206 },
			),
	);
	vi.stubGlobal("fetch", fetchMock);
	const prepared = await directTranscriptStore("u1", SESSION)?.prepareDownload(
		path,
	);
	expect(prepared?.config).toMatchObject({ dataKey: "KEYBASE64", path });
	expect(new URL(prepared?.config.url as string).pathname).toContain(path);
	const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
	expect(init.headers).toEqual({ range: "bytes=0-4095" });
	expect(vault.unseal).toHaveBeenCalledWith("v2.sealed(KEYBASE64)", {
		purpose: `claude-transcript-key:${path}`,
		userId: "u1",
	});
});

it("refuses another chat's object, and returns null for a missing or foreign-format object", async () => {
	const store = directTranscriptStore("u1", SESSION);
	const own = directTranscriptPath("u1", SESSION, CLAUDE);
	await expect(
		store?.prepareDownload(directTranscriptPath("u1", "other-session", CLAUDE)),
	).rejects.toThrow("Checkpoint ownership mismatch.");
	await expect(
		store?.prepareDownload(own.replace(".direct", ".enc")),
	).rejects.toThrow("Checkpoint ownership mismatch.");
	await expect(store?.prepareDownload(`${own}/../x.direct`)).rejects.toThrow(
		"Checkpoint ownership mismatch.",
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 404 })),
	);
	expect(await store?.prepareDownload(own)).toBeNull();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("NOTOURS\nwrapped\nmore")),
	);
	expect(await store?.prepareDownload(own)).toBeNull();
	expect(vault.unseal).not.toHaveBeenCalled();
});
