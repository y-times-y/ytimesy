import { beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	type EnvironmentBuildInput,
	prepareEnvironmentRepositories,
} from "./environment-build";

const broker = vi.hoisted(() => ({
	receive: vi.fn(async (): Promise<string> => "updated"),
}));
const install = vi.hoisted(() => vi.fn(async () => {}));
const checkout = vi.hoisted(() => vi.fn(async () => "/home/ubuntu/web"));

vi.mock("../adapters/database", () => ({
	database: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
vi.mock("../adapters/workspaces", () => ({
	recordWorkspaceEvent: async () => {},
	saveWorkspaceStatus: async () => {},
	workspaceById: async () => null,
}));
vi.mock("../adapters/github/git-broker", () => ({
	receiveBrokeredRepository: broker.receive,
}));
vi.mock("./environment-repair", () => ({
	installWithEnvironmentRepair: install,
}));
vi.mock("./prepare-project-checkout", () => ({
	prepareProjectCheckout: checkout,
}));
vi.mock("./project-secrets", () => ({
	loadProjectSecretEnvironment: async () => ({}),
}));
vi.mock("../adapters/project-secrets", () => ({
	loadProjectSecretsForOwner: async () => [],
}));

const from = "a".repeat(40);
const to = "b".repeat(40);
const input: EnvironmentBuildInput = {
	workspaceId: "workspace",
	userId: "alice",
	projectId: "project",
	// sha256("[]"): the secret revision of a project without secrets.
	secretRevision:
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	inputHash: "hash",
	baseSnapshotId: "tools",
	repositories: [
		{
			repositoryId: 1,
			installationId: 1,
			fullName: "org/web",
			branch: "main",
			commit: to,
		},
	],
	incremental: { snapshotId: "template", commits: { "1": from } },
};

/** A VM whose checkout moves from `from` to `to` and whose diff lists `changed`. */
function runtime(changed: string[], startAt = from) {
	let head = startAt;
	const commands: string[] = [];
	broker.receive.mockImplementation(async () => {
		head = to;
		return "updated";
	});
	const exec = vi.fn(async (_vm: string, argv: string[]) => {
		const command = argv.at(-1) ?? "";
		commands.push(command);
		const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
		if (command.includes("rev-parse HEAD")) return ok(head);
		if (command.includes("diff --name-only")) return ok(changed.join("\n"));
		if (command.startsWith("ls -1")) return ok("package.json\npnpm-lock.yaml");
		if (command.startsWith("cat ")) return ok('{"scripts":{}}');
		if (command.startsWith("printf")) return ok("/home/ubuntu");
		return ok();
	});
	return {
		commands,
		runtime: {
			exec,
			writeTextFile: async () => {},
		} as unknown as WorkspaceRuntime,
	};
}

beforeEach(() => {
	install.mockClear();
	checkout.mockClear();
	broker.receive.mockClear();
});

it("reuses installed dependencies when only source files changed", async () => {
	const vm = runtime(["src/app.ts"]);
	await prepareEnvironmentRepositories(input, "vm", vm.runtime);
	expect(broker.receive).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			mode: "update",
			destination: "/home/ubuntu/web",
		}),
	);
	expect(install).not.toHaveBeenCalled();
	expect(vm.commands.some((command) => command.startsWith("rm -rf"))).toBe(
		false,
	);
});

it("reinstalls on the fast-forwarded checkout when the lockfile changed", async () => {
	const vm = runtime(["pnpm-lock.yaml"]);
	await prepareEnvironmentRepositories(input, "vm", vm.runtime);
	expect(install).toHaveBeenCalledOnce();
	expect(vm.commands.some((command) => command.startsWith("rm -rf"))).toBe(
		false,
	);
});

it("reclones and reinstalls when the template checkout can't be fast-forwarded", async () => {
	const vm = runtime(["src/app.ts"], "c".repeat(40));
	await prepareEnvironmentRepositories(input, "vm", vm.runtime);
	expect(broker.receive).not.toHaveBeenCalled();
	expect(
		vm.commands.some((command) =>
			command.startsWith("rm -rf '/home/ubuntu/web'"),
		),
	).toBe(true);
	expect(install).toHaveBeenCalledOnce();
});

it("does a normal full preparation without a template", async () => {
	const vm = runtime(["src/app.ts"]);
	await prepareEnvironmentRepositories(
		{ ...input, incremental: null },
		"vm",
		vm.runtime,
	);
	expect(broker.receive).not.toHaveBeenCalled();
	expect(install).toHaveBeenCalledOnce();
});
