import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { exportGuestCheckpoint, restoreGuestCheckpoint } from "./guest";

const exec = promisify(execFile);
const host = {
	exec: async (command: string) => {
		try {
			const r = await exec("bash", ["-c", command]);
			return { ...r, exitCode: 0 };
		} catch {
			return { exitCode: 1, stdout: "", stderr: "failed" };
		}
	},
	writeTextFile: (path: string, contents: string) => writeFile(path, contents),
	readTextFile: (path: string) => readFile(path, "utf8"),
};

it("restores a shallow checkout without inventing missing parent history", async () => {
	const temp = await mkdtemp(join(tmpdir(), "checkpoint-shallow-test-"));
	try {
		const source = join(temp, "source");
		const repo = join(temp, "repo");
		await mkdir(source);
		const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
		await git("init", "-b", "main");
		for (const text of ["first", "second"]) {
			await writeFile(join(source, "file"), text);
			await git("add", ".");
			await git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.invalid",
				"commit",
				"-m",
				text,
			);
		}
		await exec("git", ["clone", "--depth=1", `file://${source}`, repo]);
		const payload = await exportGuestCheckpoint(
			host,
			[repo],
			null,
			join(temp, "export.json"),
		);
		await rm(repo, { recursive: true });
		await restoreGuestCheckpoint(
			host,
			payload,
			[repo],
			null,
			join(temp, "restore.json"),
		);
		expect(await readFile(join(repo, "file"), "utf8")).toBe("second");
		expect(
			(
				await exec("git", ["-C", repo, "rev-parse", "--is-shallow-repository"])
			).stdout.trim(),
		).toBe("true");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});

it("restores committed, staged, unstaged and untracked work without copying auth or dependencies", async () => {
	const temp = await mkdtemp(join(tmpdir(), "checkpoint-test-"));
	try {
		const repo = join(temp, "repo");
		await mkdir(repo);
		const git = (...args: string[]) => exec("git", ["-C", repo, ...args]);
		await git("init", "-b", "main");
		await writeFile(join(repo, "file.txt"), "base\n");
		await writeFile(join(repo, ".gitignore"), ".env\nnode_modules\n");
		await git("add", ".");
		await git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-m",
			"base",
		);
		await writeFile(join(repo, "file.txt"), "staged\n");
		await git("add", "file.txt");
		await writeFile(join(repo, "file.txt"), "unstaged\n");
		await writeFile(join(repo, "new.txt"), "new\n");
		await writeFile(join(repo, ".env"), "SECRET_DO_NOT_COPY");
		const native = join(temp, "native");
		await mkdir(join(native, "home/.codex/sessions"), { recursive: true });
		await writeFile(
			join(native, "home/.codex/auth.json"),
			"REFRESH_DO_NOT_COPY",
		);
		await writeFile(
			join(native, "home/.codex/sessions/thread.jsonl"),
			"history",
		);
		const payload = await exportGuestCheckpoint(
			host,
			[repo],
			native,
			join(temp, "export.json"),
		);
		expect(payload).not.toContain("auth.json");
		expect(payload).not.toContain("SECRET_DO_NOT_COPY");
		await rm(repo, { recursive: true });
		await rm(native, { recursive: true });
		await restoreGuestCheckpoint(
			host,
			payload,
			[repo],
			native,
			join(temp, "restore.json"),
		);
		expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("unstaged\n");
		expect((await git("show", ":file.txt")).stdout).toBe("staged\n");
		expect(await readFile(join(repo, "new.txt"), "utf8")).toBe("new\n");
		expect(
			await readFile(join(native, "home/.codex/sessions/thread.jsonl"), "utf8"),
		).toBe("history");
		await expect(
			readFile(join(native, "home/.codex/auth.json")),
		).rejects.toThrow();
		const corrupted = JSON.parse(payload);
		corrupted.repositories[0].files["../escape"] = "eA==";
		await expect(
			restoreGuestCheckpoint(
				host,
				JSON.stringify(corrupted),
				[repo],
				native,
				join(temp, "malicious.json"),
			),
		).rejects.toThrow("restore failed");
		expect(await readFile(join(repo, "file.txt"), "utf8")).toBe("unstaged\n");
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
});
