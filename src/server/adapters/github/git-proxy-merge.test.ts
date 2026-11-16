import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mergeRemoteBranchScript } from "./git-proxy-transfer";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ytimesy-merge-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.test",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.test",
		},
	}).trim();

/** A remote and a checkout sharing commit A; the checkout adds B, the remote adds R. */
function scenario(remoteFile: string) {
	const remote = join(root, "remote.git");
	const work = join(root, "work");
	git(root, "init", "-q", "--bare", remote);
	git(root, "init", "-q", work);
	writeFileSync(join(work, "a.txt"), "a\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "A");
	git(work, "push", "-q", remote, "HEAD:refs/heads/chat");
	writeFileSync(join(work, "b.txt"), "b\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "B");
	const other = join(root, "other");
	git(root, "clone", "-q", remote, other);
	git(other, "checkout", "-q", "chat");
	writeFileSync(join(other, remoteFile), "remote\n");
	git(other, "add", ".");
	git(other, "commit", "-qm", "R");
	git(other, "push", "-q", "origin", "chat");
	const publish = join(root, "push.git");
	git(root, "init", "-q", "--bare", publish);
	writeFileSync(
		join(publish, "objects/info/alternates"),
		`${join(work, ".git/objects")}\n`,
	);
	git(
		publish,
		"update-ref",
		"refs/heads/publish",
		git(work, "rev-parse", "HEAD"),
	);
	return { remote, publish, work };
}

const run = (publish: string, remote: string) =>
	execFileSync(
		"bash",
		[
			"-c",
			`set -u\n${mergeRemoteBranchScript("git", publish, remote, "chat")}git --git-dir=${publish} push ${remote} refs/heads/publish:refs/heads/chat`,
		],
		{ encoding: "utf8", stdio: "pipe" },
	);

it("merges a branch that moved, keeps both sides and pushes without force", () => {
	const { remote, publish } = scenario("r.txt");
	run(publish, remote);
	const files = git(remote, "ls-tree", "--name-only", "chat").split("\n");
	expect(files.sort()).toEqual(["a.txt", "b.txt", "r.txt"]);
	expect(
		git(remote, "rev-list", "--parents", "-n1", "chat").split(" "),
	).toHaveLength(3);
});

it("leaves a merge the checkout can fast-forward to, so the next turn's commit descends from the branch", () => {
	const { remote, publish, work } = scenario("r.txt");
	run(publish, remote);
	// What catching the checkout up does: fetch the branch, fast-forward only.
	git(work, "fetch", "-q", remote, "chat");
	git(work, "merge", "--ff-only", "FETCH_HEAD");
	expect(git(work, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "chat"));
	expect(git(work, "ls-files").split("\n").sort()).toEqual([
		"a.txt",
		"b.txt",
		"r.txt",
	]);
	// The next turn's commit now pushes without another rejection or merge.
	writeFileSync(join(work, "c.txt"), "c\n");
	git(work, "add", ".");
	git(work, "commit", "-qm", "next turn");
	git(work, "push", "-q", remote, "HEAD:refs/heads/chat");
	expect(git(remote, "rev-parse", "chat")).toBe(git(work, "rev-parse", "HEAD"));
});

it("exits 68 and pushes nothing when the same file conflicts", () => {
	const { remote, publish, work } = scenario("b.txt");
	const before = git(remote, "rev-parse", "chat");
	let status = 0;
	try {
		run(publish, remote);
	} catch (error) {
		status = (error as { status: number }).status;
	}
	expect(status).toBe(68);
	expect(git(remote, "rev-parse", "chat")).toBe(before);
	expect(work).toBeTruthy();
});
