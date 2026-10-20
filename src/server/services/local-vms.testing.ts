import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceId } from "#/domain/ids";
import { PROJECT_CWD_PATH } from "../adapters/freestyle/clone-project";
import type { WorkspaceMachines } from "./workspace-machines";

/**
 * Local "VMs": each id is a home directory holding a repository; commands
 * run with bash in that home. A fork copies the parent's home, the way a
 * VM snapshot carries uncommitted work.
 */
export function localVms() {
	const root = mkdtempSync(join(tmpdir(), "subagent-writer-"));
	const homes = new Map<string, string>();
	const path = (vm: string, file: string) =>
		file === PROJECT_CWD_PATH
			? join(homes.get(vm) as string, ".project-cwd")
			: file;
	const machines = {
		exec: async (vm: string, command: string) => {
			try {
				const stdout = execFileSync("bash", ["-c", command], {
					cwd: homes.get(vm),
					env: { ...process.env, HOME: homes.get(vm) },
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
				return { exitCode: 0, stdout, stderr: "" };
			} catch (error) {
				const failure = error as { status?: number; stderr?: string };
				return {
					exitCode: failure.status ?? 1,
					stdout: "",
					stderr: String(failure.stderr ?? ""),
				};
			}
		},
		readTextFile: async (vm: string, file: string) => {
			try {
				return readFileSync(path(vm, file), "utf8");
			} catch {
				return null;
			}
		},
		writeTextFile: async (vm: string, file: string, contents: string) => {
			writeFileSync(path(vm, file), contents);
		},
		forkWorkspace: async (source: string, slug: string) => {
			const home = join(root, slug);
			cpSync(homes.get(source) as string, home, { recursive: true });
			const cwd = join(home, "repo");
			writeFileSync(join(home, ".project-cwd"), `${cwd}\n`);
			homes.set(slug, home);
			return { vm: WorkspaceId(slug), forkMs: 5 };
		},
	} as unknown as WorkspaceMachines;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	const parentHome = join(root, "parent");
	const parentRepo = join(parentHome, "repo");
	execFileSync("mkdir", ["-p", parentRepo]);
	homes.set("parent", parentHome);
	writeFileSync(join(parentHome, ".project-cwd"), `${parentRepo}\n`);
	git(parentRepo, "init", "-q", "-b", "main");
	git(parentRepo, "config", "user.email", "t@example.test");
	git(parentRepo, "config", "user.name", "t");
	writeFileSync(join(parentRepo, "a.ts"), "export const a = 1;\n");
	writeFileSync(join(parentRepo, "shared.ts"), "line 1\nline 2\nline 3\n");
	git(parentRepo, "add", "-A");
	git(parentRepo, "commit", "-q", "-m", "init");
	return { root, machines, git, parentRepo, homes };
}
