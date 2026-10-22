import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { fetchedBranchCommand } from "./git-branch-switch";

let root = "";
const git = (directory: string, ...args: string[]) => {
	const result = spawnSync("git", [
		"-C",
		directory,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		...args,
	]);
	if (result.status !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
};
async function commit(directory: string, name: string) {
	await writeFile(join(directory, name), `${name}\n`);
	git(directory, "add", ".");
	git(directory, "commit", "-qm", name);
	return git(directory, "rev-parse", "HEAD");
}
function receive(
	guest: string,
	upstream: string,
	mode: "clone" | "switch",
	pinnedRevision?: string,
) {
	git(guest, "fetch", "-q", "--no-tags", upstream, "refs/heads/main");
	return spawnSync("bash", [
		"-c",
		`set -eu\n${fetchedBranchCommand({
			directory: guest,
			branch: "main",
			workingBranch: "ytimesy/new-chat-1",
			mode,
			originUrl: "https://github.com/acme/app.git",
			pinnedRevision,
		})}`,
	]);
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ytimesy-pinned-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it.each(["clone", "switch"] as const)(
	"lands a %s and its base on the pinned commit after the branch moved on",
	async (mode) => {
		const upstream = join(root, "upstream");
		const guest = join(root, "guest");
		await mkdir(upstream);
		git(upstream, "init", "-q", "-b", "main");
		const pinned = await commit(upstream, "one.txt");
		await mkdir(guest);
		git(guest, "init", "-q");
		if (mode === "switch") {
			// A template checkout on another branch.
			git(guest, "fetch", "-q", upstream, "refs/heads/main");
			git(guest, "checkout", "-q", "-b", "template", "FETCH_HEAD");
		}
		const latest = await commit(upstream, "two.txt");
		const result = receive(guest, upstream, mode, pinned);
		expect(result.status, result.stderr.toString()).toBe(0);
		expect(git(guest, "rev-parse", "HEAD")).toBe(pinned);
		expect(git(guest, "rev-parse", "refs/ytimesy/base")).toBe(pinned);
		expect(git(guest, "branch", "--show-current")).toBe("ytimesy/new-chat-1");
		// The remote branch still records where it really is.
		expect(git(guest, "rev-parse", "refs/remotes/origin/main")).toBe(latest);
	},
);

it("fails rather than land elsewhere when the pinned commit is not in the fetch", async () => {
	const upstream = join(root, "upstream");
	const guest = join(root, "guest");
	await mkdir(upstream);
	git(upstream, "init", "-q", "-b", "main");
	await commit(upstream, "one.txt");
	await mkdir(guest);
	git(guest, "init", "-q");
	const result = receive(guest, upstream, "clone", "d".repeat(40));
	expect(result.status).not.toBe(0);
	expect(result.stderr.toString()).toContain("pinned commit");
	expect(() => git(guest, "rev-parse", "-q", "--verify", "HEAD")).toThrow();
});

it("refuses a pinned revision that is not a commit id", () => {
	expect(() =>
		fetchedBranchCommand({
			directory: "/repo",
			branch: "main",
			workingBranch: "main",
			mode: "clone",
			originUrl: "https://github.com/acme/app.git",
			pinnedRevision: "main; rm -rf /",
		}),
	).toThrow("Invalid pinned revision.");
});
