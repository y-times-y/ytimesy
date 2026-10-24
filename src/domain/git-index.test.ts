import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gitIndexPaths } from "./git-index";

const git = (cwd: string, ...args: string[]) =>
	spawnSync("git", args, { cwd, encoding: "utf8" }).stdout;

it.each([2, 3, 4])(
	"reads the paths git ls-files prints from an index version %i",
	async (version) => {
		const root = await mkdtemp(join(tmpdir(), "ytimesy-index-"));
		try {
			git(root, "init", "-q");
			await mkdir(join(root, "src/deep/er"), { recursive: true });
			const names = [
				"README.md",
				"src/a.ts",
				"src/deep/er/b.ts",
				"src/deep/er/bb.ts",
				"src/deep/c with space.ts",
				"src/émoji-ü.ts",
				`${"x".repeat(70)}.txt`,
			];
			for (const name of names) await writeFile(join(root, name), name);
			git(root, "add", "-A");
			// An intent-to-add entry carries the extended flags only version 3 has.
			if (version === 3) {
				await writeFile(join(root, "new.ts"), "n");
				git(root, "add", "--intent-to-add", "new.ts");
			}
			git(root, "update-index", "--index-version", String(version));
			const bytes = await readFile(join(root, ".git/index"));
			expect(bytes.readUInt32BE(4)).toBe(version);
			expect(gitIndexPaths(bytes)).toEqual(
				git(root, "-c", "core.quotepath=off", "ls-files")
					.split("\n")
					.filter(Boolean),
			);
			expect(gitIndexPaths(bytes, 2)).toHaveLength(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("refuses bytes that are not an index", () => {
	expect(
		gitIndexPaths(new TextEncoder().encode("not an index at all")),
	).toBeNull();
	expect(gitIndexPaths(new Uint8Array(0))).toBeNull();
});
