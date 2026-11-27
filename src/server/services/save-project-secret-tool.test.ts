import { describe, expect, it, vi } from "vitest";
import {
	SAVE_PROJECT_SECRET_TOOL,
	saveProjectSecretTools,
} from "./save-project-secret-tool";

function run(stdout: string, exitCode = 0) {
	const save = vi.fn(async () => {});
	const tools = saveProjectSecretTools({
		runInWorkspace: async () => ({ exitCode, stdout }),
		save,
	});
	const execute = tools[SAVE_PROJECT_SECRET_TOOL]?.execute as (
		input: unknown,
		options: unknown,
	) => Promise<Record<string, unknown>>;
	return {
		save,
		call: () =>
			execute(
				{
					name: "FLY_API_TOKEN",
					valueCommand: "fly auth token",
					kind: "runtime",
					scope: "account",
				},
				{},
			),
	};
}

describe("save_project_secret", () => {
	it("saves the command output and never returns it", async () => {
		const { save, call } = run("gho_secretvalue123\n");
		const result = await call();
		expect(save).toHaveBeenCalledWith({
			name: "FLY_API_TOKEN",
			kind: "runtime",
			value: "gho_secretvalue123",
			scope: "account",
		});
		expect(JSON.stringify(result)).not.toContain("gho_secretvalue123");
	});
	it("saves nothing when the command fails or prints nothing", async () => {
		for (const [out, code] of [
			["", 0],
			["x", 1],
		] as const) {
			const { save, call } = run(out, code);
			expect(await call()).toMatchObject({ saved: false });
			expect(save).not.toHaveBeenCalled();
		}
	});
});

describe("save_project_secret for GitHub", () => {
	it("refuses a GitHub token or `gh auth` and runs nothing", async () => {
		const runInWorkspace = vi.fn(async () => ({ exitCode: 0, stdout: "x" }));
		const save = vi.fn(async () => {});
		const execute = saveProjectSecretTools({ runInWorkspace, save })[
			SAVE_PROJECT_SECRET_TOOL
		]?.execute as (i: unknown, o: unknown) => Promise<{ error?: string }>;
		for (const input of [
			{ name: "GH_TOKEN", valueCommand: "echo x" },
			{ name: "MY_KEY", valueCommand: "gh auth token" },
		]) {
			const out = await execute(
				{ ...input, kind: "runtime", scope: "project" },
				{},
			);
			expect(out.error).toMatch(/GitHub is connected; push the branch/);
		}
		expect(runInWorkspace).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});
});
