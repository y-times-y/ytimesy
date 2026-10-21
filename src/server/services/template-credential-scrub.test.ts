import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
	SCRUB_VALUES_VARIABLE,
	scrubValues,
	templateCredentialScrub,
} from "./template-credential-scrub";

const run = promisify(execFile);

it("removes home credential files, untracked .env files and untracked files holding a secret", async () => {
	const root = await mkdtemp(join(tmpdir(), "scrub-"));
	try {
		const home = join(root, "home");
		const repo = join(root, "repo");
		await mkdir(join(home, ".docker"), { recursive: true });
		await mkdir(join(repo, "node_modules/pkg"), { recursive: true });
		await mkdir(join(repo, "config"), { recursive: true });
		for (const file of [".npmrc", ".netrc", ".git-credentials", ".pypirc"])
			await writeFile(join(home, file), "token");
		await writeFile(join(home, ".docker/config.json"), "{}");
		await writeFile(join(home, ".bashrc"), "keep");
		await run("git", ["init", "-q", repo]);
		await writeFile(join(repo, "tracked.txt"), "build-secret-value");
		await writeFile(join(repo, ".env.example"), "KEY=");
		await run("git", ["-C", repo, "add", "."]);
		await run("git", [
			"-C",
			repo,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			"init",
		]);
		await writeFile(join(repo, ".env"), "KEY=anything");
		await writeFile(join(repo, ".env.untracked-example.example"), "KEY=");
		await writeFile(
			join(repo, "config/generated.json"),
			'{"t":"build-secret-value"}',
		);
		await writeFile(join(repo, "config/plain.json"), "{}");
		await writeFile(join(repo, "node_modules/pkg/x.js"), "build-secret-value");
		await run(
			"bash",
			["-c", templateCredentialScrub({ checkouts: [repo], homes: [home] })],
			{
				env: {
					...process.env,
					[SCRUB_VALUES_VARIABLE]: scrubValues({
						A: "build-secret-value",
						B: "short",
					}),
				},
			},
		);
		expect((await readdir(home)).sort()).toEqual([".bashrc", ".docker"]);
		expect(await readdir(join(home, ".docker"))).toEqual([]);
		expect((await readdir(repo)).sort()).toEqual([
			".env.example",
			".env.untracked-example.example",
			".git",
			"config",
			"node_modules",
			"tracked.txt",
		]);
		expect(await readdir(join(repo, "config"))).toEqual(["plain.json"]);
		expect(await readdir(join(repo, "node_modules/pkg"))).toEqual(["x.js"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("drops values too short to match safely", () => {
	expect(scrubValues({ A: "abc", B: "long-enough" })).toBe("long-enough");
});
