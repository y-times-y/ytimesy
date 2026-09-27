import { randomBytes } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/domain/encrypted-secret";
import { loadProjectSecretEnvironment } from "../src/server/services/project-secrets";

const mocks = vi.hoisted(() => ({
	owner: vi.fn(),
	stored: vi.fn(),
	key: vi.fn(),
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: mocks.owner,
}));
vi.mock("../src/server/adapters/project-secrets", () => ({
	loadProjectSecretsForOwner: mocks.stored,
}));
vi.mock("../src/server/secrets/master-key", () => ({
	loadSecretMasterKey: mocks.key,
}));

beforeEach(() => {
	vi.resetAllMocks();
	const key = randomBytes(32);
	mocks.key.mockResolvedValue(key);
	mocks.owner.mockResolvedValue({ id: "project" });
	mocks.stored.mockResolvedValue([
		{ name: "PACKAGE_TOKEN", encrypted: encryptSecret(key, "package-fixture") },
		{ name: "RUNTIME_TOKEN", encrypted: encryptSecret(key, "runtime-fixture") },
	]);
});

it("exposes only explicitly named build secrets", async () => {
	expect(
		await loadProjectSecretEnvironment("alice", "project", ["PACKAGE_TOKEN"]),
	).toEqual({ PACKAGE_TOKEN: "package-fixture" });
	expect(await loadProjectSecretEnvironment("alice", "project", [])).toEqual(
		{},
	);
});

it("rejects missing secrets rather than starting a misconfigured build", async () => {
	await expect(
		loadProjectSecretEnvironment("alice", "project", ["MISSING"]),
	).rejects.toThrow("required build secret is missing");
});

it("checks ownership before decrypting credentials", async () => {
	mocks.owner.mockResolvedValue(null);
	await expect(
		loadProjectSecretEnvironment("bob", "project", ["PACKAGE_TOKEN"]),
	).rejects.toThrow("not available");
	expect(mocks.stored).not.toHaveBeenCalled();
	expect(mocks.key).not.toHaveBeenCalled();
});
