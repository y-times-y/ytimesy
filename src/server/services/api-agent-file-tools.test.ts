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
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			try {
				const result = await run("bash", [
					"-lc",
					command.replaceAll(
						"/tmp/ytimesy-environment.json",
						join(root, "environment-report.json"),
					),
				]);
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
	return { root, tools, commands };
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
	expect(Object.keys(tools)).toEqual([
		"read_environment_report",
		"read_files",
		"inspect_changes",
		"verify_changes",
	]);
});

it("reports absent setup metadata without a failed read or arbitrary path access", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "other.txt"), "not the report");
	expect(
		await call(tools.read_environment_report, { start: 0, path: "other.txt" }),
	).toEqual({ available: false });
});

it("reads setup metadata in bounded Unicode-preserving pages", async () => {
	const { root, tools } = await fixture(true);
	const text = `${"你".repeat(32_000)}baseline check failed: exit 2`;
	await writeFile(join(root, "environment-report.json"), text);
	expect(await call(tools.read_environment_report, { start: 0 })).toEqual({
		available: true,
		start: 0,
		text: text.slice(0, 32_000),
		nextStart: 32_000,
	});
	expect(await call(tools.read_environment_report, { start: 32_000 })).toEqual({
		available: true,
		start: 32_000,
		text: text.slice(32_000),
		nextStart: null,
	});
});

it("rejects a symlink in place of the prepared report", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "private.txt"), "private");
	await symlink("private.txt", join(root, "environment-report.json"));
	await expect(
		call(tools.read_environment_report, { start: 0 }),
	).rejects.toThrow("safely read");
});

it("reads several known files in order without writing to the repository", async () => {
	const { root, tools, commands } = await fixture(true);
	await writeFile(join(root, "first.txt"), "first\n");
	await writeFile(join(root, "second's.txt"), "second 你好\n");
	expect(
		await call(tools.read_files, { paths: ["second's.txt", "first.txt"] }),
	).toEqual([
		{ path: "second's.txt", content: "second 你好\n", truncated: false },
		{ path: "first.txt", content: "first\n", truncated: false },
	]);
	expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
	expect(commands).toHaveLength(1);
});

it("bounds each file and the complete multi-file response, with explicit truncation", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "large.txt"), "x".repeat(40_000));
	const rows = (await call(tools.read_files, {
		paths: ["large.txt", "large.txt", "large.txt"],
	})) as { content: string; truncated: boolean }[];
	expect(rows.map((row) => row.content.length)).toEqual([32_000, 32_000, 0]);
	expect(rows.every((row) => row.truncated)).toBe(true);
});

it("rejects traversal, absolute paths, .git reads, and escaping symlinks", async () => {
	const { root, tools } = await fixture(true);
	const external = await fixture(true);
	await writeFile(join(external.root, "other.txt"), "private outside content");
	await symlink(external.root, join(root, "outside"));
	await symlink(".git", join(root, "metadata"));
	for (const path of [
		"../outside.txt",
		join(root, "inside.txt"),
		".git/config",
		"metadata/config",
		"outside/other.txt",
		join(external.root, "other.txt"),
	]) {
		await expect(call(tools.read_files, { paths: [path] })).rejects.toThrow();
	}
});

it("enforces the file-count bound even when invoked without schema validation", async () => {
	const { tools } = await fixture(true);
	for (const paths of [[], Array(9).fill("same.txt")]) {
		await expect(call(tools.read_files, { paths })).rejects.toThrow();
	}
});

it("does not return partial evidence when a requested file is missing", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "present.txt"), "present");
	await expect(
		call(tools.read_files, { paths: ["present.txt", "missing.txt"] }),
	).rejects.toThrow();
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
