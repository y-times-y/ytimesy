import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { agentTaskDiffScript } from "./agent-task-diff";

it("shows staged, unstaged, and untracked task changes", () => {
	const repo = mkdtempSync(join(tmpdir(), "ytimesy-task-diff-"));
	try {
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		git("init", "-q");
		writeFileSync(join(repo, "staged.txt"), "before\n");
		writeFileSync(join(repo, "unstaged.txt"), "before\n");
		git("add", ".");
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"initial",
		);
		writeFileSync(join(repo, "staged.txt"), "staged content\n");
		git("add", "staged.txt");
		writeFileSync(join(repo, "unstaged.txt"), "unstaged content\n");
		writeFileSync(join(repo, "new file.md"), "untracked content\n");
		const output = execFileSync(
			"sh",
			["-c", `set -eu\n${agentTaskDiffScript}`],
			{
				cwd: repo,
				encoding: "utf8",
			},
		);
		expect(output).toContain("staged content");
		expect(output).toContain("unstaged content");
		expect(output).toContain("untracked content");
		expect(output).toContain("new file.md");
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
});
