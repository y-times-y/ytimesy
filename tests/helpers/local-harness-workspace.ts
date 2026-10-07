import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkspaceId } from "../../src/domain/ids";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";

const run = promisify(execFile);
export async function localHarnessWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-claude-gaps-"));
	await run("git", ["init", "-q", root]);
	await run("git", ["-C", root, "config", "user.name", "Fixture"]);
	await run("git", ["-C", root, "config", "user.email", "fixture@localhost"]);
	await writeFile(join(root, ".gitignore"), "node_modules/\n.env\n");
	await writeFile(join(root, "source.txt"), "original\n");
	await run("git", ["-C", root, "add", "."]);
	await run("git", ["-C", root, "commit", "-qm", "initial"]);
	const machines = {
		exec: async (_vm: string, command: string, timeout = 30000) => {
			try {
				const result = await run("bash", ["-lc", command], {
					cwd: root,
					timeout,
					maxBuffer: 2 * 1024 * 1024,
				});
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (cause) {
				const error = cause as { code: number; stdout: string; stderr: string };
				return {
					exitCode: typeof error.code === "number" ? error.code : 1,
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? "",
				};
			}
		},
		ensureRunning: async (id: WorkspaceId) => id,
		readTextFile: async (_vm: string, path: string) => readFile(path, "utf8"),
		writeTextFile: async (_vm: string, path: string, content: string) =>
			writeFile(path, content),
	} as unknown as WorkspaceMachines;
	return {
		root,
		workspace: { machines, vm: WorkspaceId("fixture"), cwd: root },
		run,
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
