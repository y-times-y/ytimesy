import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commitAllArgv } from "#/server/adapters/repository-setup";
import {
	clearStaleGitIndexLock,
	STALE_GIT_LOCK_MINUTES,
} from "./git-stale-lock";
import { publicationCommitAuthor } from "./publication";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function repository() {
	const root = mkdtempSync(join(tmpdir(), "ytimesy-git-lock-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(root, "a.txt"), "one\n");
	git("add", "-A");
	git(
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@e.invalid",
		"commit",
		"-qm",
		"1",
	);
	return { root, git, lock: join(root, ".git", "index.lock") };
}

function commit(root: string) {
	const [command, flag, script] = commitAllArgv(
		root,
		"Agent: update",
		publicationCommitAuthor({}),
	);
	return spawnSync(command, [flag, script], { encoding: "utf8" });
}

it("commits past an index.lock an interrupted Git command left behind", () => {
	const { root, git, lock } = repository();
	// A killed `git worktree add` / turn leaves the lock with no process.
	// Old enough to count as stale even while other tests run Git meanwhile.
	writeFileSync(lock, "");
	const then = new Date(Date.now() - (STALE_GIT_LOCK_MINUTES + 1) * 60_000);
	utimesSync(lock, then, then);
	writeFileSync(join(root, "a.txt"), "two\n");
	const result = commit(root);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stderr).toContain("Removed a stale Git lock");
	expect(git("log", "--format=%s", "-1").trim()).toBe("Agent: update");
	expect(existsSync(lock)).toBe(false);
});

it.runIf(existsSync("/proc/self/fd"))(
	"leaves a lock a running process still holds",
	async () => {
		const { root, lock } = repository();
		// Holds the lock open as a running Git command does.
		const holder = spawn("sh", ["-c", `exec 3>"$1"; sleep 30`, "sh", lock]);
		cleanups.push(() => holder.kill());
		for (let i = 0; i < 50 && !existsSync(lock); i++)
			await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 100));
		const result = spawnSync(
			"sh",
			["-eu", "-c", clearStaleGitIndexLock(root)],
			{
				encoding: "utf8",
			},
		);
		expect(result.status).toBe(0);
		expect(existsSync(lock)).toBe(true);
	},
);

it("is a no-op, never a failure, without a lock or outside a repository", () => {
	const { root } = repository();
	for (const directory of [root, tmpdir()]) {
		const result = spawnSync(
			"sh",
			["-eu", "-c", clearStaleGitIndexLock(directory)],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	}
});
