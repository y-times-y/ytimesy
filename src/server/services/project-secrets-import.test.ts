import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	owner: vi.fn(),
	list: vi.fn(),
	save: vi.fn(),
}));
vi.mock("#/server/adapters/projects", () => ({ projectForOwner: mocks.owner }));
vi.mock("#/server/adapters/project-secrets", () => ({
	listProjectSecretsForOwner: mocks.list,
	saveProjectSecretForOwner: mocks.save,
	loadProjectSecretsForOwner: vi.fn(),
	deleteProjectSecretForOwner: vi.fn(),
}));
vi.mock("#/server/secrets/master-key", () => ({
	loadSecretMasterKey: async () => new Uint8Array(32).fill(7),
}));

const { saveImportedProjectSecrets } = await import("./project-secrets");

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
	mocks.save.mockResolvedValue({});
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
