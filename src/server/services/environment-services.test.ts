import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { environmentRecipe } from "#/domain/project-environment";
import {
	startEnvironmentServices,
	startRecipeServices,
	stopRecipeServices,
} from "./environment-services";

const recipe = environmentRecipe.parse({
	services: [
		{ name: "web", command: "pnpm dev", port: 3000 },
		{ name: "api", command: "pnpm api", port: 4000, timeoutSeconds: 5 },
	],
});
const repository = {
	repositoryId: 1,
	fullName: "org/app",
	directory: "/home/ubuntu/app",
	commit: "a".repeat(40),
	recipe,
};

it("reports each service, with its terminal's last lines when it did not come up", async () => {
	const exec = vi.fn(async (command: string, _timeoutMs: number) =>
		command.includes("4000")
			? { exitCode: 1, stdout: "Error: API_KEY is missing" }
			: { exitCode: 0, stdout: "" },
	);
	expect(await startRecipeServices(exec, [repository])).toEqual([
		{ repositoryId: 1, name: "web", port: 3000, ready: true, output: "" },
		{
			repositoryId: 1,
			name: "api",
			port: 4000,
			ready: false,
			output: "Error: API_KEY is missing",
		},
	]);
	expect(exec.mock.calls[0]?.[0]).toContain("tmux new-session -d -s");
	expect(exec.mock.calls[1]?.[1]).toBe(10_000);
	await stopRecipeServices(exec, [repository]);
	expect(exec.mock.calls.at(-1)?.[0]).toContain(
		"tmux kill-session -t 'ytimesy-1-web'",
	);
});

it("starts a chat machine's services and adds the results to its environment report", async () => {
	const files = new Map([
		[
			"/tmp/ytimesy-environment.json",
			JSON.stringify({ version: 1, notice: "n", repositories: [repository] }),
		],
	]);
	const machines = {
		readTextFile: vi.fn(
			async (_vm: unknown, path: string) => files.get(path) ?? null,
		),
		writeTextFile: vi.fn(async (_vm: unknown, path: string, text: string) => {
			files.set(path, text);
		}),
		exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
	};
	const results = await startEnvironmentServices(machines, WorkspaceId("vm"));
	expect(results.map((result) => result.ready)).toEqual([true, true]);
	const report = JSON.parse(files.get("/tmp/ytimesy-environment.json") ?? "");
	expect(report.notice).toBe("n");
	expect(report.repositories[0].services).toHaveLength(2);
});

it("does nothing on a machine without saved services", async () => {
	const machines = {
		readTextFile: vi.fn(async () =>
			JSON.stringify({
				version: 1,
				repositories: [{ ...repository, recipe: environmentRecipe.parse({}) }],
			}),
		),
		writeTextFile: vi.fn(),
		exec: vi.fn(),
	};
	expect(await startEnvironmentServices(machines, WorkspaceId("vm"))).toEqual(
		[],
	);
	expect(machines.exec).not.toHaveBeenCalled();
	expect(machines.writeTextFile).not.toHaveBeenCalled();
});
