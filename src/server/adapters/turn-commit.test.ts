import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { agentTaskDiffScript } from "../services/agent-task-diff";
import {
	exportGuestCheckpoint,
	restoreGuestCheckpoint,
} from "./checkpoints/guest";
import { automaticTurnCommitArgv } from "./turn-commit";

const exec = promisify(execFile);
async function repository(test: (repo: string) => Promise<void>) {
	const repo = await mkdtemp(join(tmpdir(), "ytimesy-turn-commit-"));
	try {
		await exec("git", ["init", "-q", "-b", "main", repo]);
		await writeFile(join(repo, "tracked.txt"), "initial\n");
		await exec("git", ["-C", repo, "add", "."]);
		await exec("git", [
			"-C",
			repo,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"-qm",
			"Initial",
		]);
		await exec("git", ["-C", repo, "update-ref", "refs/ytimesy/base", "HEAD"]);
		await test(repo);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
}
async function commit(repo: string, turn = "a".repeat(64)) {
	const [binary, ...args] = automaticTurnCommitArgv(
		repo,
		turn,
		"Agent: Fix user's `parser` $(unsafe)",
	);
	return exec(binary, args);
}

it("commits tracked and new files once under concurrent completion observations and retains the review diff", async () => {
	await repository(async (repo) => {
		await writeFile(join(repo, "tracked.txt"), "fixed\n");
		await writeFile(join(repo, "new file.txt"), "added\n");
		await Promise.all([commit(repo), commit(repo)]);
		expect(
			(
				await exec("git", ["-C", repo, "rev-list", "--count", "HEAD"])
			).stdout.trim(),
		).toBe("2");
		expect(
			(await exec("git", ["-C", repo, "status", "--porcelain"])).stdout,
		).toBe("");
		expect(
			(
				await exec("git", ["-C", repo, "log", "-1", "--format=%s"])
			).stdout.trim(),
		).toBe("Agent: Fix user's `parser` $(unsafe)");
		const diff = await exec("bash", ["-c", agentTaskDiffScript], { cwd: repo });
		expect(diff.stdout).toContain("+fixed");
		expect(diff.stdout).toContain("+added");
		await writeFile(join(repo, "tracked.txt"), "next turn\n");
		await commit(repo);
		expect(
			(await exec("git", ["-C", repo, "status", "--porcelain"])).stdout,
		).toContain("tracked.txt");
		await commit(repo, "b".repeat(64));
		expect(
			(
				await exec("git", ["-C", repo, "rev-list", "--count", "HEAD"])
			).stdout.trim(),
		).toBe("3");
	});
});

it("skips clean turns and retries failed commit hooks without recording success", async () => {
	await repository(async (repo) => {
		await commit(repo);
		expect(
			(
				await exec("git", ["-C", repo, "rev-list", "--count", "HEAD"])
			).stdout.trim(),
		).toBe("1");
		await writeFile(join(repo, "tracked.txt"), "changed\n");
		const hook = join(repo, ".git/hooks/pre-commit");
		await writeFile(hook, "#!/bin/sh\nexit 1\n");
		await chmod(hook, 0o755);
		await expect(commit(repo, "b".repeat(64))).rejects.toThrow();
		await rm(hook);
		await commit(repo, "b".repeat(64));
		expect(
			(
				await exec("git", ["-C", repo, "rev-list", "--count", "HEAD"])
			).stdout.trim(),
		).toBe("2");
	});
});

it("does not stage files during an unfinished merge", async () => {
	await repository(async (repo) => {
		await writeFile(join(repo, "tracked.txt"), "conflict\n");
		await writeFile(
			join(repo, ".git/MERGE_HEAD"),
			(await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout,
		);
		await expect(commit(repo)).rejects.toThrow("finish the Git conflict");
		expect((await exec("git", ["-C", repo, "diff", "--cached"])).stdout).toBe(
			"",
		);
	});
});

it("retains the review base and completion receipts through checkpoint restoration", async () => {
	await repository(async (repo) => {
		await writeFile(join(repo, "tracked.txt"), "saved\n");
		await commit(repo);
		const host = {
			exec: async (command: string) => {
				const result = await exec("bash", ["-c", command]);
				return { ...result, exitCode: 0 };
			},
			writeTextFile: (path: string, contents: string) =>
				writeFile(path, contents),
			readTextFile: (path: string) => readFile(path, "utf8"),
		};
		const payload = await exportGuestCheckpoint(
			host,
			[repo],
			null,
			`${repo}-checkpoint-export`,
		);
		await restoreGuestCheckpoint(
			host,
			payload,
			[repo],
			null,
			`${repo}-checkpoint-restore`,
		);
		const diff = await exec("bash", ["-c", agentTaskDiffScript], { cwd: repo });
		expect(diff.stdout).toContain("+saved");
		await writeFile(join(repo, "tracked.txt"), "later\n");
		await commit(repo);
		expect(
			(await exec("git", ["-C", repo, "status", "--porcelain"])).stdout,
		).toContain("tracked.txt");
	});
});
