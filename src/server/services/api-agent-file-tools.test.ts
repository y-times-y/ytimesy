import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { apiAgentFileTools } from "./api-agent-file-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(readOnly = false) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-file-tools-"));
	roots.push(root);
	await run("git", ["init", "-q", root]);
	const machines = {
		exec: async (_vm: string, command: string) => {
			try {
				const result = await run("bash", ["-lc", command]);
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failed = error as Error & {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: failed.code,
					stdout: failed.stdout,
					stderr: failed.stderr,
				};
			}
		},
		writeTextFile: async (_vm: string, path: string, contents: string) =>
			writeFile(path, contents),
	} as unknown as WorkspaceMachines;
	const tools = apiAgentFileTools({
		machines,
		vm: WorkspaceId("test-vm"),
		cwd: root,
		readOnly,
		signal: new AbortController().signal,
		once: async (_id, execute) => execute(),
	});
	return { root, tools };
}

async function call(tool: unknown, input: object) {
	return (
		tool as { execute: (args: object, options: object) => Promise<unknown> }
	).execute(input, { toolCallId: "edit" });
}

it("creates and precisely replaces a file without overwriting an existing one", async () => {
	const { root, tools } = await fixture();
	await call(tools.create_file, {
		path: "src/example.ts",
		content: "const value = 1;\n",
	});
	await expect(
		call(tools.create_file, { path: "src/example.ts", content: "overwrite" }),
	).rejects.toThrow();
	await call(tools.replace_text, {
		path: "src/example.ts",
		old: "value = 1",
		new: "value = 2",
	});
	expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe(
		"const value = 2;\n",
	);
});

it("rejects paths outside the repository and ambiguous edits", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "same.txt"), "same same");
	await expect(
		call(tools.create_file, { path: "../outside.txt", content: "bad" }),
	).rejects.toThrow();
	await expect(
		call(tools.replace_text, { path: "same.txt", old: "same", new: "new" }),
	).rejects.toThrow();
	expect(await readFile(join(root, "same.txt"), "utf8")).toBe("same same");
});

it("does not edit through a symlink", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "target.txt"), "original");
	await symlink("target.txt", join(root, "link.txt"));
	await expect(
		call(tools.replace_text, {
			path: "link.txt",
			old: "original",
			new: "changed",
		}),
	).rejects.toThrow();
	expect(await readFile(join(root, "target.txt"), "utf8")).toBe("original");
});

it("only offers inspection to a read-only lead", async () => {
	const { tools } = await fixture(true);
	expect(Object.keys(tools)).toEqual(["inspect_changes", "verify_changes"]);
});

it("reports diff-check failures without claiming a clean verification", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "tracked.txt"), "clean\n");
	await run("git", ["-C", root, "add", "tracked.txt"]);
	await writeFile(join(root, "tracked.txt"), "trailing space  \n");
	const result = (await call(tools.verify_changes, {})) as { passed: boolean };
	expect(result.passed).toBe(false);
});

it("also checks staged changes and inspects a repository without a commit", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "staged.txt"), "trailing space  \n");
	await run("git", ["-C", root, "add", "staged.txt"]);
	const inspection = (await call(tools.inspect_changes, {})) as string;
	expect(inspection).toContain("staged.txt");
	const result = (await call(tools.verify_changes, {})) as { passed: boolean };
	expect(result.passed).toBe(false);
});
