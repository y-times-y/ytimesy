import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	owner: vi.fn(),
	list: vi.fn(),
	save: vi.fn(),
	load: vi.fn(),
}));
vi.mock("#/server/adapters/projects", () => ({ projectForOwner: mocks.owner }));
vi.mock("#/server/adapters/project-secrets", () => ({
	listProjectSecretsForOwner: mocks.list,
	saveProjectSecretForOwner: mocks.save,
	loadProjectSecretsForOwner: mocks.load,
	deleteProjectSecretForOwner: vi.fn(),
}));
vi.mock("#/server/secrets/master-key", () => ({
	loadSecretMasterKey: async () => new Uint8Array(32).fill(7),
}));

const {
	saveImportedProjectSecrets,
	saveVisibleProjectSecret,
	loadAgentProjectSecrets,
} = await import("./project-secrets");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.owner.mockResolvedValue({ id: "p" });
	mocks.list.mockResolvedValue([
		{ id: "1", name: "SET_BY_USER", kind: "runtime", hint: "", updatedAt: "" },
		{
			id: "2",
			name: "IMPORTED_BEFORE",
			kind: "runtime",
			hint: "",
			updatedAt: "",
			imported: true,
		},
	]);
	mocks.save.mockReset().mockResolvedValue({});
	mocks.load.mockReset().mockResolvedValue([]);
});

it("makes an explicitly saved secret available to every turn in its owner project", async () => {
	const stored = new Map<string, unknown[]>();
	mocks.save.mockImplementation(async (input) => {
		stored.set(`${input.userId}:${input.projectId}`, [input]);
		return { name: input.name, kind: input.kind };
	});
	mocks.load.mockImplementation(
		async (userId, projectId) => stored.get(`${userId}:${projectId}`) ?? [],
	);
	await saveVisibleProjectSecret({
		userId: "alice",
		projectId: "p",
		name: "SERVICE_TOKEN",
		value: "synthetic-service-credential",
		kind: "runtime",
	});
	for (let turn = 0; turn < 2; turn++) {
		const secrets = await loadAgentProjectSecrets("alice", "p");
		expect(secrets.names).toEqual([{ name: "SERVICE_TOKEN", kind: "runtime" }]);
		expect(secrets.envFile).toContain("synthetic-service-credential");
		expect(secrets.redact).toEqual(["synthetic-service-credential"]);
	}
	expect(
		(await loadAgentProjectSecrets("alice", "different-project")).names,
	).toEqual([]);
	expect((await loadAgentProjectSecrets("bob", "p")).names).toEqual([]);
	expect(JSON.stringify(mocks.save.mock.calls)).not.toContain(
		"synthetic-service-credential",
	);
});

it("refuses an explicit save without an owned project instead of storing thread-local credentials", async () => {
	mocks.owner.mockResolvedValue(null);
	await expect(
		saveVisibleProjectSecret({
			userId: "alice",
			projectId: "",
			name: "SERVICE_TOKEN",
			value: "synthetic-service-credential",
			kind: "runtime",
		}),
	).rejects.toThrow("Project is not available.");
	expect(mocks.save).not.toHaveBeenCalled();
});

it("saves .env values encrypted and marked imported, keeping what the user set", async () => {
	const result = await saveImportedProjectSecrets({
		userId: "alice",
		projectId: "p",
		variables: [
			{ name: "DATABASE_URL", value: "postgres://user:pass@host/db" },
			{ name: "PORT", value: "3000" },
			{ name: "SET_BY_USER", value: "other-value" },
			{ name: "IMPORTED_BEFORE", value: "refreshed-value" },
			{ name: "lowercase", value: "value123" },
			{ name: "EMPTY", value: "" },
		],
	});
	expect(result.saved).toEqual(["DATABASE_URL", "PORT", "IMPORTED_BEFORE"]);
	expect(result.skipped.map((entry) => entry.name)).toEqual([
		"SET_BY_USER",
		"lowercase",
		"EMPTY",
	]);
	const saved = mocks.save.mock.calls.map(([input]) => input);
	expect(saved.every((input) => input.imported === true)).toBe(true);
	// Long values are redacted runtime secrets; short ones plain variables.
	expect(saved.map((input) => [input.name, input.kind])).toEqual([
		["DATABASE_URL", "runtime"],
		["PORT", "environment"],
		["IMPORTED_BEFORE", "runtime"],
	]);
	expect(JSON.stringify(saved)).not.toContain("postgres://user:pass@host/db");
});
