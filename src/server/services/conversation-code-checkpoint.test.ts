import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import {
	assertConversationCodePresent,
	captureConversationCode,
	FORK_CHECKPOINT_GONE,
	restoreConversationCode,
	startCheckoutFromConversationCode,
} from "./conversation-code-checkpoint";
import { reviewRef } from "./review-loop";

it("restores binary, staged, unstaged, deleted and untracked files while preserving ignored files and branch history", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const { root, workspace, run } = fixture;
		await writeFile(join(root, "source.txt"), "staged\n");
		await run("git", ["-C", root, "add", "source.txt"]);
		await writeFile(join(root, "source.txt"), "unstaged\n");
		await writeFile(join(root, "binary.dat"), Buffer.from([0, 255, 123]));
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "node_modules/keep"), "dependency");
		await writeFile(join(root, ".env"), "private");
		const beforeIndex = (
			await run("git", ["-C", root, "write-tree"])
		).stdout.trim();
		const beforeHead = (
			await run("git", ["-C", root, "rev-parse", "HEAD"])
		).stdout.trim();
		const checkpoint = await captureConversationCode(workspace);
		expect((await run("git", ["-C", root, "write-tree"])).stdout.trim()).toBe(
			beforeIndex,
		);
		await writeFile(join(root, "source.txt"), "later\n");
		await writeFile(join(root, "new.txt"), "remove me");
		await run("git", ["-C", root, "add", "-A"]);
		await run("git", ["-C", root, "commit", "-qm", "later"]);
		const laterHead = (
			await run("git", ["-C", root, "rev-parse", "HEAD"])
		).stdout.trim();
		await writeFile(join(root, "extra.txt"), "untracked later");
		const backup = await captureConversationCode(workspace);
		await writeFile(join(root, "concurrent.txt"), "terminal edit");
		await expect(
			restoreConversationCode(workspace, checkpoint, backup),
		).rejects.toThrow("Code rewind failed");
		expect(await readFile(join(root, "concurrent.txt"), "utf8")).toBe(
			"terminal edit",
		);
		const current = await captureConversationCode(workspace);
		await restoreConversationCode(workspace, checkpoint, current);
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("unstaged\n");
		expect(await readFile(join(root, "binary.dat"))).toEqual(
			Buffer.from([0, 255, 123]),
		);
		await expect(readFile(join(root, "new.txt"))).rejects.toThrow();
		await expect(readFile(join(root, "extra.txt"))).rejects.toThrow();
		expect((await run("git", ["-C", root, "write-tree"])).stdout.trim()).toBe(
			beforeIndex,
		);
		expect(
			(await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
		).toBe(laterHead);
		expect(laterHead).not.toBe(beforeHead);
		expect(await readFile(join(root, ".env"), "utf8")).toBe("private");
		expect(await readFile(join(root, "node_modules/keep"), "utf8")).toBe(
			"dependency",
		);
		await restoreConversationCode(workspace, backup);
		expect(await readFile(join(root, "extra.txt"), "utf8")).toBe(
			"untracked later",
		);
		await expect(
			restoreConversationCode(workspace, {
				...checkpoint,
				tree: "0".repeat(40),
			}),
		).rejects.toThrow("Code rewind failed");
		expect(await readFile(join(root, "extra.txt"), "utf8")).toBe(
			"untracked later",
		);
	} finally {
		await fixture.cleanup();
	}
}, 30_000);

it("removes files created after a chat's first message, committed or not, from the Files listing", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const { root, workspace, run } = fixture;
		const listed = async () =>
			(
				await run("git", ["-C", root, "ls-files", "-co", "--exclude-standard"])
			).stdout
				.trim()
				.split("\n");
		// Captured before the first turn's tools ran.
		const firstMessage = await captureConversationCode(workspace);
		await writeFile(join(root, "qa-hello.txt"), "hello\n");
		for (const committed of [false, true]) {
			if (committed) {
				await writeFile(join(root, "qa-hello.txt"), "hello\n");
				await run("git", ["-C", root, "add", "-A"]);
				await run("git", ["-C", root, "commit", "-qm", "turn 1"]);
			}
			const backup = await captureConversationCode(workspace);
			await restoreConversationCode(workspace, firstMessage, backup);
			await expect(readFile(join(root, "qa-hello.txt"))).rejects.toThrow();
			expect(await listed()).not.toContain("qa-hello.txt");
		}
	} finally {
		await fixture.cleanup();
	}
}, 30_000);

it("captures the review loop's refs (refs/ytimesy/review/...) as well as the attempt loop's", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const { root, workspace, run } = fixture;
		await writeFile(join(root, "source.txt"), "reviewed\n");
		for (const ref of [
			reviewRef("turn-1", "base"),
			"refs/ytimesy/attempts/turn-1-a1",
		]) {
			const snapshot = await captureConversationCode(workspace, ref);
			expect(snapshot.ref).toBe(ref);
			expect(
				(
					await run("git", ["-C", root, "rev-parse", `${ref}^{tree}`])
				).stdout.trim(),
			).toBe(snapshot.tree);
		}
	} finally {
		await fixture.cleanup();
	}
});

it("starts a copied checkout on its own branch at a message's code, leaving the source as it is", async () => {
	const fixture = await localHarnessWorkspace();
	try {
		const { root, workspace, run } = fixture;
		const git = async (dir: string, ...args: string[]) =>
			(await run("git", ["-C", dir, ...args])).stdout.trim();
		// The message's code: a staged edit, an unstaged one and an untracked file.
		await writeFile(join(root, "source.txt"), "staged\n");
		await git(root, "add", "source.txt");
		await writeFile(join(root, "source.txt"), "at the message\n");
		await writeFile(join(root, "notes.txt"), "untracked\n");
		const atMessage = await captureConversationCode(workspace);
		const index = await git(root, "write-tree");
		// Later turns commit and change more on the source's branch.
		await writeFile(join(root, "source.txt"), "later\n");
		await writeFile(join(root, "later.txt"), "later\n");
		await git(root, "add", "-A");
		await git(root, "commit", "-qm", "later turn");
		await writeFile(join(root, "scratch.txt"), "uncommitted later\n");
		const sourceBranch = await git(root, "branch", "--show-current");
		const sourceHead = await git(root, "rev-parse", "HEAD");
		await assertConversationCodePresent(workspace, atMessage);
		// A VM fork is a disk copy: ignored files and local refs come along.
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "node_modules/keep"), "dependency");
		const copy = `${root}-fork`;
		await run("cp", ["-a", root, copy]);
		await startCheckoutFromConversationCode(
			{ ...workspace, cwd: copy },
			atMessage,
			"ytimesy/fork-abc123",
		);
		expect(await git(copy, "branch", "--show-current")).toBe(
			"ytimesy/fork-abc123",
		);
		expect(await git(copy, "rev-parse", "HEAD")).toBe(atMessage.head);
		expect(await git(copy, "write-tree")).toBe(index);
		expect(await readFile(join(copy, "source.txt"), "utf8")).toBe(
			"at the message\n",
		);
		expect(await readFile(join(copy, "notes.txt"), "utf8")).toBe("untracked\n");
		await expect(readFile(join(copy, "later.txt"))).rejects.toThrow();
		await expect(readFile(join(copy, "scratch.txt"))).rejects.toThrow();
		expect(await readFile(join(copy, "node_modules/keep"), "utf8")).toBe(
			"dependency",
		);
		// The source keeps its branch, commits and uncommitted work.
		expect(await git(root, "branch", "--show-current")).toBe(sourceBranch);
		expect(await git(root, "rev-parse", "HEAD")).toBe(sourceHead);
		expect(await readFile(join(root, "scratch.txt"), "utf8")).toBe(
			"uncommitted later\n",
		);
		expect(await readFile(join(root, "source.txt"), "utf8")).toBe("later\n");
		// A checkpoint whose refs are gone fails with the fork's error, changing nothing.
		await git(root, "update-ref", "-d", atMessage.ref);
		await expect(
			assertConversationCodePresent(workspace, atMessage),
		).rejects.toThrow(FORK_CHECKPOINT_GONE);
		await git(copy, "update-ref", "-d", `${atMessage.ref}-index`);
		await writeFile(join(copy, "source.txt"), "fork edit\n");
		await expect(
			startCheckoutFromConversationCode(
				{ ...workspace, cwd: copy },
				atMessage,
				"ytimesy/fork-other",
			),
		).rejects.toThrow(FORK_CHECKPOINT_GONE);
		expect(await git(copy, "branch", "--show-current")).toBe(
			"ytimesy/fork-abc123",
		);
		expect(await readFile(join(copy, "source.txt"), "utf8")).toBe(
			"fork edit\n",
		);
		await run("rm", ["-rf", copy]);
	} finally {
		await fixture.cleanup();
	}
}, 30_000);
