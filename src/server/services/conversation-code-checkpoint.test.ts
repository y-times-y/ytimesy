import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import {
	captureConversationCode,
	restoreConversationCode,
} from "./conversation-code-checkpoint";

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
