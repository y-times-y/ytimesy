import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dependencyCacheSpec } from "#/domain/dependency-cache";

const r2 = vi.hoisted(() => ({ size: vi.fn(), deleted: [] as string[] }));
vi.mock("../adapters/checkpoints/r2", async (load) => ({
	...(await load<typeof import("../adapters/checkpoints/r2")>()),
	r2ObjectSize: r2.size,
	r2DeletePrefix: vi.fn(async (_config: unknown, prefix: string) => {
		r2.deleted.push(prefix);
		return 1;
	}),
}));

const {
	dependencyCacheKey,
	removeRepositoryDependencyCaches,
	removeUserDependencyCaches,
	restoreDependencyCache,
} = await import("./dependency-cache");

beforeEach(() => {
	vi.stubEnv("R2_ACCOUNT_ID", "a".repeat(32));
	vi.stubEnv("R2_ACCESS_KEY_ID", "id");
	vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
	vi.stubEnv("R2_CHECKPOINT_BUCKET", "ytimesy-dev");
	r2.size.mockReset();
	r2.deleted.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const inputs = {
	userId: "alice",
	repositoryId: 42,
	stack: "npm" as const,
	install: "npm ci",
	baseSnapshotId: "tools-1",
	inputsHash: "f".repeat(64),
};

it("keys archives per person and repository, and on stack, install, image and lockfiles", () => {
	const key = dependencyCacheKey(inputs);
	expect(dependencyCacheKey(inputs)).toBe(key);
	// Never another person's archive, even for the same repository and lockfile.
	expect(dependencyCacheKey({ ...inputs, userId: "bob" })).not.toBe(key);
	expect(
		dependencyCacheKey({ ...inputs, userId: "bob" }).split("/")[2],
	).not.toBe(key.split("/")[2]);
	for (const changed of [
		{ repositoryId: 43 },
		{ stack: "pnpm" as const },
		{ install: "npm ci --omit=dev" },
		{ baseSnapshotId: "tools-2" },
		{ inputsHash: "e".repeat(64) },
	])
		expect(dependencyCacheKey({ ...inputs, ...changed })).not.toBe(key);
	expect(key).not.toContain("alice");
});

function host(hash: string) {
	return {
		exec: vi.fn(async () => ({ exitCode: 0, stdout: `${hash}\n` })),
		execWithEnv: vi.fn(async () => ({ exitCode: 0, stdout: "" })),
	};
}
const spec = dependencyCacheSpec(
	["package.json", "package-lock.json"],
	"npm ci",
);

it("knows a miss without a guest command, and restores a hit with a short one", async () => {
	if (!spec) throw new Error("no spec");
	const request = {
		directory: "/home/ubuntu/app",
		spec,
		userId: "alice",
		repositoryId: 42,
		install: "npm ci",
		baseSnapshotId: "tools-1",
	};
	r2.size.mockResolvedValueOnce(null);
	const missing = host("f".repeat(64));
	expect(await restoreDependencyCache({ ...request, host: missing })).toEqual({
		key: expect.stringContaining("dependency-cache/v1/"),
		restored: false,
	});
	expect(missing.execWithEnv).not.toHaveBeenCalled();
	r2.size.mockResolvedValueOnce(20 * 1024 * 1024);
	const hit = host("f".repeat(64));
	expect(await restoreDependencyCache({ ...request, host: hit })).toMatchObject(
		{
			restored: true,
		},
	);
	const [, env, timeout] = hit.execWithEnv.mock.calls[0] as unknown as [
		string,
		Record<string, string>,
		number,
	];
	expect(env.YTIMESY_DEPENDENCY_CACHE_URL).toContain("X-Amz-Signature=");
	expect(timeout).toBe(30_000);
	// Install scripts a restore cannot replay: no cache at all.
	expect(
		await restoreDependencyCache({ ...request, host: host("lifecycle") }),
	).toBeNull();
});

it("removes a project's repositories' archives and all of an account's", async () => {
	await removeRepositoryDependencyCaches("alice", [42, 7]);
	await removeUserDependencyCaches("alice");
	expect(r2.deleted).toHaveLength(3);
	expect(r2.deleted[0]).toMatch(/^dependency-cache\/v1\/[a-f0-9]{64}\/42\/$/);
	expect(r2.deleted[2]).toMatch(/^dependency-cache\/v1\/[a-f0-9]{64}\/$/);
	expect(r2.deleted[0].startsWith(r2.deleted[2])).toBe(true);
});
