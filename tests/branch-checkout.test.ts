import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { switchBrokeredBranchCommand } from "../src/server/adapters/github/git-broker";

const exec = promisify(execFile);
it("switches divergent branches without merging or resetting either history, and protects dirty edits", async () => {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-branch-test-"));
	const git = async (...args: string[]) =>
		(await exec("git", ["-C", directory, ...args])).stdout.trim();
	try {
		await git("init", "-b", "main");
		await git("config", "user.name", "Fixture");
		await git("config", "user.email", "fixture@example.test");
		await writeFile(join(directory, "file.txt"), "base\n");
		await git("add", ".");
		await git("commit", "-m", "base");
		const main = await git("rev-parse", "HEAD");
		await git("checkout", "-b", "feature");
		await writeFile(join(directory, "file.txt"), "feature\n");
		await git("commit", "-am", "feature");
		const feature = await git("rev-parse", "HEAD");
		await exec("sh", [
			"-eu",
			"-c",
			switchBrokeredBranchCommand(directory, "main"),
		]);
		expect(await git("rev-parse", "HEAD")).toBe(main);
		expect(await git("rev-parse", "feature")).toBe(feature);
		await exec("sh", [
			"-eu",
			"-c",
			switchBrokeredBranchCommand(directory, "feature"),
		]);
		expect(await git("rev-parse", "HEAD")).toBe(feature);
		await writeFile(join(directory, "file.txt"), "unsaved\n");
		await expect(
			exec("sh", ["-eu", "-c", switchBrokeredBranchCommand(directory, "main")]),
		).rejects.toThrow("Commit or stash");
		expect(await git("branch", "--show-current")).toBe("feature");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
