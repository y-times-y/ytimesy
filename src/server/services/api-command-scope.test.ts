import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { SOURCE_AGENT_SECRETS } from "#/domain/project-secret";
import { scopedShellCommand, stopApiTurnCommands } from "./api-command-scope";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
it.runIf(process.platform === "linux")(
	"captures noninteractive output without inherited forced color",
	async () => {
		const turnId = crypto.randomUUID();
		try {
			const result = await run(
				"bash",
				[
					"-lc",
					scopedShellCommand({
						turnId,
						cwd: "/tmp",
						command:
							'python3 -c \'import os; print(os.environ.get("NO_COLOR"), os.environ.get("FORCE_COLOR"), os.environ.get("TERM"))\'',
						seconds: 5,
					}),
				],
				{ env: { ...process.env, FORCE_COLOR: "1" } },
			);
			expect(result.stdout.trim()).toBe("1 None dumb");
		} finally {
			await rm(`/tmp/ytimesy-api-command-scopes/${turnId}`, {
				recursive: true,
				force: true,
			});
		}
	},
);
it("rejects a command scope that could escape its own directory", () => {
	expect(() =>
		scopedShellCommand({
			turnId: "../other",
			cwd: "/tmp",
			command: "true",
			seconds: 1,
		}),
	).toThrow("scope");
});
it.runIf(process.platform === "linux")(
	"stops a TERM-resistant command and rejects late starts in that turn",
	async () => {
		const turnId = crypto.randomUUID();
		const cwd = await mkdtemp(join(tmpdir(), "ytimesy-scoped-command-"));
		const workspace = {
			vm: WorkspaceId("fixture"),
			cwd,
			machines: {
				exec: async (_vm: string, command: string) => {
					try {
						const value = await run("bash", ["-lc", command]);
						return { exitCode: 0, stdout: value.stdout, stderr: value.stderr };
					} catch (error) {
						const value = error as {
							code: number;
							stdout: string;
							stderr: string;
						};
						return {
							exitCode: value.code,
							stdout: value.stdout,
							stderr: value.stderr,
						};
					}
				},
			} as unknown as WorkspaceMachines,
		};
		let command: Promise<unknown> | undefined;
		try {
			command = run("bash", [
				"-lc",
				scopedShellCommand({
					turnId,
					cwd,
					command:
						"trap '' TERM; while true; do printf x >> ticks; sleep .05; done",
					seconds: 30,
				}),
			]).catch(() => {});
			await vi.waitFor(async () =>
				expect(
					(await readFile(join(cwd, "ticks"), "utf8")).length,
				).toBeGreaterThan(0),
			);
			await stopApiTurnCommands(workspace, turnId);
			await command;
			const stopped = await readFile(join(cwd, "ticks"), "utf8");
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(await readFile(join(cwd, "ticks"), "utf8")).toBe(stopped);
			expect(
				(
					await workspace.machines.exec(
						workspace.vm,
						scopedShellCommand({
							turnId,
							cwd,
							command: "printf bad >> ticks",
							seconds: 5,
						}),
						10_000,
					)
				).exitCode,
			).toBe(130);
		} finally {
			await stopApiTurnCommands(workspace, turnId);
			await command;
			await rm(cwd, { recursive: true, force: true });
			await rm(`/tmp/ytimesy-api-command-scopes/${turnId}`, {
				recursive: true,
				force: true,
			});
		}
	},
	10_000,
);

it("keeps quote-heavy scripts linear in size through nested shell layers", () => {
	// A Python heredoc full of single quotes, like the agent's scripts.
	const script = `python3 - <<'PY'\n${"print('a', 'b', {'k': 'v'})\n".repeat(120)}PY`;
	const scoped = scopedShellCommand({
		turnId: crypto.randomUUID(),
		cwd: "/app",
		command: script,
		seconds: 30,
	});
	// Wrap it the way tmux, bash -lc and docker exec do: quote it twice more.
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const nested = quote(quote(scoped));
	// The script travels base64-encoded after the env-file loader line.
	expect(scoped).toContain(
		Buffer.from(`${SOURCE_AGENT_SECRETS}\n${script}`).toString("base64"),
	);
	expect(nested.length).toBeLessThan(scoped.length * 2);
	expect(nested.length).toBeLessThan(script.length * 4 + 8_000);
});
