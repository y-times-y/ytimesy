import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
	INDEXED_SEARCH_SOURCE,
	repositorySearchCommand,
} from "./indexed-repository-search";

const run = promisify(execFile);

it("matches Git across warm refreshes, exclusions, scoped queries, and unsupported text", async () => {
	const cwd = await realpath(
		await mkdtemp(join(tmpdir(), "ytimesy-index-test-")),
	);
	const cache = join(
		tmpdir(),
		`ytimesy-search-${process.getuid?.()}-${createHash("sha256").update(cwd).digest("hex")}`,
	);
	const search = async (
		query: string,
		literal = true,
		path = ".",
		source = INDEXED_SEARCH_SOURCE,
	) => {
		const invoke = async (command: string, args: string[]) => {
			try {
				return { ...(await run(command, args)), code: 0 };
			} catch (error) {
				const failure = error as {
					code: number;
					stdout: string;
					stderr: string;
				};
				if (failure.code !== 1) throw error;
				return failure;
			}
		};
		const indexed = await invoke("python3", [
			"-c",
			source,
			JSON.stringify({ cwd, query, literal, path }),
		]);
		const direct = await invoke("git", [
			"--literal-pathspecs",
			"-C",
			cwd,
			"grep",
			"--untracked",
			"--exclude-standard",
			"-n",
			"-I",
			...(literal ? ["-F"] : []),
			"-e",
			query,
			"--",
			path,
		]);
		expect(indexed.stdout).toBe(direct.stdout);
		expect(indexed.stderr).toBe(direct.stderr);
		expect(indexed.code).toBe(direct.code);
		return indexed;
	};
	try {
		await run("git", ["init", "-q", cwd]);
		await mkdir(join(cwd, "src[1]"));
		await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
		await writeFile(join(cwd, "ignored.txt"), "needle\n");
		await writeFile(join(cwd, "tracked.ts"), "before\n");
		await run("git", ["-C", cwd, "add", "tracked.ts"]);
		await writeFile(
			join(cwd, "src[1]", "untracked.ts"),
			'needle quoted "token"\n',
		);
		await writeFile(
			join(cwd, "invalid.txt"),
			Buffer.from([110, 101, 101, 100, 108, 101, 255, 10]),
		);
		await writeFile(join(cwd, "binary.txt"), Buffer.from("needle\0"));
		await search("needle");
		const inspect = await run("python3", [
			"-c",
			"import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); print(json.dumps(list(c.execute('select path from contents order by path'))))",
			join(cache, "index.sqlite"),
		]);
		expect(JSON.parse(inspect.stdout)).toEqual([
			[".gitignore"],
			["src[1]/untracked.ts"],
			["tracked.ts"],
		]);
		await writeFile(join(cwd, "tracked.ts"), "needle after edit\n");
		await search("needle");
		await search("needle", true, "src[1]");
		await rm(join(cwd, "src[1]", "untracked.ts"));
		await search("needle");
		await search("ne", true);
		await search("needle|before", false);
		await search('"token"');
		await search("missing");
		await search(
			"needle",
			true,
			".",
			INDEXED_SEARCH_SOURCE.replace(
				"tokenize='trigram'",
				"tokenize='nonexistent'",
			),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
		await rm(cache, { recursive: true, force: true });
	}
});

it("shell-quotes executable source and JSON input", () => {
	const command = repositorySearchCommand({
		cwd: "/repo",
		path: ".",
		query: "'; touch /tmp/unwanted; '",
		literal: true,
	});
	expect(command).toContain("'\\''; touch /tmp/unwanted; '\\''");
});
