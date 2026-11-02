import { beforeEach, expect, it, vi } from "vitest";
import { EnvironmentCommandFailure } from "#/domain/environment-build-progress";
import { environmentRecipe } from "#/domain/project-environment";
import type { EnvironmentBuildSteps } from "../adapters/environment-build-steps";
import type { WorkspaceRuntime } from "../adapters/workspace-runtime";
import {
	type EnvironmentBuildInput,
	prepareEnvironmentRepositories,
	verifyEnvironmentRepositories,
} from "./environment-build";
import { EnvironmentInstallFailed } from "./environment-repair";

const install = vi.hoisted(() =>
	vi.fn(async (_input: { command: string }) => {}),
);
const secrets = vi.hoisted(() => ({ values: {} as Record<string, string> }));

vi.mock("../adapters/database", () => ({
	database: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));
vi.mock("../adapters/workspaces", () => ({
	recordWorkspaceEvent: async () => {},
	saveWorkspaceStatus: async () => {},
	workspaceById: async () => null,
}));
vi.mock("./environment-repair", async (importOriginal) => ({
	...(await importOriginal<typeof import("./environment-repair")>()),
	installWithEnvironmentRepair: install,
}));
vi.mock("./prepare-project-checkout", () => ({
	prepareProjectCheckout: async () => "/home/ubuntu/app",
}));
vi.mock("./project-secrets", () => ({
	loadProjectSecretEnvironment: async () => secrets.values,
}));
vi.mock("../adapters/project-secrets", () => ({
	loadProjectSecretsForOwner: async () => [],
}));

const input: EnvironmentBuildInput = {
	workspaceId: "workspace",
	userId: "alice",
	projectId: "project",
	secretRevision:
		"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
	inputHash: "hash",
	baseSnapshotId: "tools",
	repositories: [
		{
			repositoryId: 7,
			installationId: 1,
			fullName: "org/app",
			branch: "main",
			commit: "a".repeat(40),
		},
	],
	incremental: null,
};

/** A VM whose checkout holds `files` (and optionally a recipe file). */
function vm(files: string[], recipeFile = "", exitCode = 0) {
	return {
		exec: vi.fn(async (_vm: string, argv: string[]) => {
			const command = argv.at(-1) ?? "";
			const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
			if (command.startsWith("printf")) return ok("/home/ubuntu");
			if (command.startsWith("ls -1")) return ok(files.join("\n"));
			if (command.startsWith("if [ -f")) return ok(recipeFile);
			if (command.startsWith("cat ")) return ok('{"scripts":{"test":"x"}}');
			return { exitCode, stdout: "check output", stderr: "" };
		}),
		writeTextFile: async () => {},
	} as unknown as WorkspaceRuntime;
}

function recorder() {
	const events: string[] = [];
	const steps: EnvironmentBuildSteps = {
		start: async (key, label, command) => {
			events.push(`start ${key} ${label}${command ? ` (${command})` : ""}`);
		},
		output: async (key, output) => {
			events.push(`output ${key} ${output}`);
		},
		finish: async (key, state, details) => {
			events.push(
				`${state} ${key}${details?.note ? ` ${details.note}` : ""}${details?.exitCode != null ? ` exit ${details.exitCode}` : ""}`,
			);
		},
	};
	return { events, steps };
}

beforeEach(() => {
	install.mockReset();
	install.mockResolvedValue(undefined);
	secrets.values = {};
});

it("gives a repository nothing recognizes a plain checkout instead of failing", async () => {
	const { events, steps } = recorder();
	const [repo] = await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["README.md", "main.c"]),
		steps,
	);
	expect(repo?.setup).toEqual({
		repositoryId: 7,
		fullName: "org/app",
		source: "none",
		detected: null,
	});
	expect(install).not.toHaveBeenCalled();
	expect(events).toEqual([
		"start clone:7 Cloning org/app",
		"done clone:7",
		"start detect:7 Detecting the stack",
		"done detect:7 Nothing to install detected",
		"start install:7 Installing dependencies",
		"skipped install:7 Nothing to install was detected",
	]);
});

it("streams what it detected as its own step before installing", async () => {
	const { events, steps } = recorder();
	await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["pyproject.toml", "uv.lock"]),
		steps,
	);
	expect(events.slice(2, 4)).toEqual([
		"start detect:7 Detecting the stack",
		"done detect:7 Python (uv)",
	]);
	expect(events[4]).toMatch(
		/^start install:7 Installing dependencies \(.*uv sync --frozen\)$/,
	);
});

it("installs a Python repository from its lockfile", async () => {
	const [repo] = await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["pyproject.toml", "uv.lock"]),
	);
	expect(repo?.setup).toMatchObject({
		source: "detected",
		detected: "Python (uv)",
	});
	expect(install.mock.calls[0]?.[0].command).toContain("uv sync --frozen");
});

it("keeps going when a detected install fails, recording why", async () => {
	install.mockRejectedValue(
		new EnvironmentInstallFailed({
			exitCode: 1,
			stdout: "\u001b[31merror\u001b[0m: failed to download go.dev/x\n",
			stderr: "",
		}),
	);
	const { events, steps } = recorder();
	const [repo] = await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["go.mod"]),
		steps,
	);
	expect(repo?.setup?.installFailure).toEqual({
		step: "Installing dependencies",
		command: "go mod download",
		exitCode: 1,
		output: "error: failed to download go.dev/x",
	});
	expect(events).toContain("failed install:7 exit 1");
	// Its checks are not run against a failed install.
	const verified = await verifyEnvironmentRepositories(
		input,
		"vm",
		repo ? [repo] : [],
		vm([]),
		steps,
	);
	expect(verified[0]?.checkResults).toBeUndefined();
});

it("fails the build with the real command and output when a saved install fails", async () => {
	secrets.values = { NPM_TOKEN: "npm_s3cret_value" };
	install.mockRejectedValue(
		new EnvironmentInstallFailed({
			exitCode: 254,
			stdout: "auth failed for npm_s3cret_value\nnpm ERR! code E401",
			stderr: "",
		}),
	);
	const failure = await prepareEnvironmentRepositories(
		{
			...input,
			repositories: [
				{
					...input.repositories[0],
					savedRecipe: environmentRecipe.parse({
						install: "npm ci",
						buildSecrets: ["NPM_TOKEN"],
					}),
				},
			],
		},
		"vm",
		vm(["package.json", "package-lock.json"]),
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(EnvironmentCommandFailure);
	const { failure: details } = failure as EnvironmentCommandFailure;
	expect(details).toMatchObject({ command: "npm ci", exitCode: 254 });
	expect(details.output).toContain("npm ERR! code E401");
	expect(details.output).not.toContain("npm_s3cret_value");
});

it("uses the repository's file over detection, and clones only when setup is skipped", async () => {
	const [file] = await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["package.json"], JSON.stringify({ install: "make deps" })),
	);
	expect(file?.setup).toMatchObject({ source: "file", install: "make deps" });
	install.mockClear();
	const { events, steps } = recorder();
	const [plain] = await prepareEnvironmentRepositories(
		{ ...input, plain: true },
		"vm",
		vm(["package.json", "pnpm-lock.yaml"]),
		steps,
	);
	expect(plain?.setup?.source).toBe("plain");
	expect(install).not.toHaveBeenCalled();
	expect(events).toContain("skipped install:7 Setup skipped");
});

it("falls back to detection when the repository's file is not a valid setup", async () => {
	const [repo] = await prepareEnvironmentRepositories(
		input,
		"vm",
		vm(["Cargo.toml"], "{ not json"),
	);
	expect(repo?.setup).toMatchObject({ source: "detected", detected: "Rust" });
});

it("stops on a failed verify command with its exit code and output", async () => {
	const { events, steps } = recorder();
	const failure = await verifyEnvironmentRepositories(
		input,
		"vm",
		[
			{
				...input.repositories[0],
				directory: "/home/ubuntu/app",
				recipe: environmentRecipe.parse({ verify: ["make test"] }),
			},
		],
		vm([], "", 2),
		steps,
	).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(EnvironmentCommandFailure);
	expect((failure as EnvironmentCommandFailure).failure).toEqual({
		step: "Running checks",
		command: "make test",
		exitCode: 2,
		output: "check output",
	});
	expect(events).toEqual([
		"start checks Running checks (make test)",
		"failed checks exit 2",
	]);
});
