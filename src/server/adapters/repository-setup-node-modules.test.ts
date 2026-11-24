import { execFileSync, spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { publicationCommitAuthor } from "#/domain/publication";
import { writerPatchExclusion } from "#/domain/subagent";
import { commitAllArgv } from "./repository-setup";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function repository() {
	const root = mkdtempSync(join(tmpdir(), "ytimesy-node-modules-"));
	roots.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.name", "t");
	git("config", "user.email", "t@example.invalid");
	// The repository ignores node_modules the usual way, with a trailing slash.
	writeFileSync(join(root, ".gitignore"), "node_modules/\n");
	writeFileSync(join(root, "README.md"), "one\n");
	git("add", "-A");
	git("commit", "-q", "-m", "init");
	return { root, git };
}

it("never commits a node_modules symlink an agent linked into its checkout", () => {
	const { root, git } = repository();
	const shared = join(root, "..", `${root.split("/").at(-1)}-deps`);
	mkdirSync(shared);
	roots.push(shared);
	symlinkSync(shared, join(root, "node_modules"));
	mkdirSync(join(root, "packages", "web"), { recursive: true });
	symlinkSync(shared, join(root, "packages", "web", "node_modules"));
	writeFileSync(join(root, "README.md"), "two\n");
	const [command, flag, script] = commitAllArgv(
		root,
		"Agent: update",
		publicationCommitAuthor({}),
	);
	const result = spawnSync(command, [flag, script], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	const committed = git("ls-tree", "-r", "--name-only", "HEAD").split("\n");
	expect(committed).toContain("README.md");
	expect(committed.filter((path) => path.includes("node_modules"))).toEqual([]);
	// Left on disk, out of history.
	expect(lstatSync(join(root, "node_modules")).isSymbolicLink()).toBe(true);
});

it("keeps a writer's node_modules entry out of its patch even when its brief names node_modules", () => {
	const named = "Symlink node_modules into the worktree before running tests.";
	for (const path of ["node_modules", "packages/web/node_modules"])
		expect(
			writerPatchExclusion({ path, bytes: 40, binary: false }, named),
		).toBe("scratch");
});
