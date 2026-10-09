import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
	INDEXED_SEARCH_SOURCE,
	indexedRepositorySearchEnabled,
	repositorySearchCommand,
} from "./indexed-repository-search";

const run = promisify(execFile);

it("enables indexed search by default with an explicit operator opt-out", () => {
	expect(indexedRepositorySearchEnabled(undefined)).toBe(true);
	expect(indexedRepositorySearchEnabled("1")).toBe(true);
	expect(indexedRepositorySearchEnabled("0")).toBe(false);
	expect(indexedRepositorySearchEnabled("invalid")).toBe(false);
});
const fixtureIndexSource = INDEXED_SEARCH_SOURCE.replace(
	"MIN_INDEX_BYTES = 16 * 1024 * 1024",
	"MIN_INDEX_BYTES = 0",
);

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
		source = fixtureIndexSource,
		wordBoundary = false,
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
			JSON.stringify({ cwd, query, literal, wordBoundary, path }),
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
			...(wordBoundary ? ["-w"] : []),
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
		await search("needle", false, ".", INDEXED_SEARCH_SOURCE);
		await expect(
			run("python3", [
				"-c",
				"import os,sys; assert not os.path.exists(sys.argv[1])",
				join(cache, "index.sqlite"),
			]),
		).resolves.toBeDefined();
		await search("needle", false);
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
		await writeFile(
			join(cwd, "words.ts"),
			"needle\nneedles\nprefix_needle\n(needle)\n",
		);
		const words = await search("needle", false, ".", fixtureIndexSource, true);
		expect(words.stdout).toContain("words.ts:1:needle");
		expect(words.stdout).toContain("words.ts:4:(needle)");
		expect(words.stdout).not.toContain("words.ts:2:");
		expect(words.stdout).not.toContain("words.ts:3:");
		await search("need.*", false, ".", fixtureIndexSource, true);
		await rm(join(cwd, "src[1]", "untracked.ts"));
		await search("needle");
		await search("ne", true);
		await search("needle|before", false);
		await search('"token"');
		await search("missing");
		await writeFile(join(cwd, "false-candidate.ts"), "nee but no full term\n");
		await search("needle");
		await writeFile(join(cwd, "punctuation.ts"), 'a b\n***needle\n"to other\n');
		await search("a b");
		await search("***needle");
		await search('"token"');
		// Upgrade disposable legacy caches, rather than querying positional data as v2.
		await run("python3", [
			"-c",
			"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=0'); c.execute('DELETE FROM contents'); c.commit()",
			join(cache, "index.sqlite"),
		]);
		await search("needle");
		const version = await run("python3", [
			"-c",
			"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA user_version').fetchone()[0])",
			join(cache, "index.sqlite"),
		]);
		expect(version.stdout.trim()).toBe("2");
		await search(
			"needle",
			true,
			".",
			fixtureIndexSource.replace(
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
		useIndex: true,
	});
	expect(command).toContain("'\\''; touch /tmp/unwanted; '\\''");
});

it("defaults to native Git without index startup or inventory overhead", () => {
	const command = repositorySearchCommand({
		cwd: "/repo",
		query: "identifier",
		literal: false,
		path: "src/[literal]",
		wordBoundary: true,
	});
	expect(command).toBe(
		"git --literal-pathspecs -C '/repo' grep --untracked --exclude-standard -n -I -w -e 'identifier' -- 'src/[literal]'",
	);
	expect(command).not.toContain("python3");
});

it("executes hostile query text as data on the native fallback", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ytimesy-search-quote-"));
	try {
		await run("git", ["init", "-q", cwd]);
		await writeFile(join(cwd, "source.txt"), "ordinary content\n");
		const marker = join(cwd, "unexpected");
		const command = repositorySearchCommand({
			cwd,
			path: ".",
			literal: true,
			query: `'; touch ${marker}; echo '`,
		});
		await expect(run("bash", ["-lc", command])).rejects.toMatchObject({
			code: 1,
		});
		await expect(access(marker)).rejects.toThrow();
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it("keeps search usable without Python and bypasses index startup for regexes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "ytimesy-search-fallback-"));
	try {
		await run("git", ["init", "-q", cwd]);
		await writeFile(join(cwd, "source.txt"), "identifier\n");
		const bin = join(cwd, "bin");
		await mkdir(bin);
		const git = (await run("which", ["git"])).stdout.trim();
		await symlink(git, join(bin, "git"));
		const search = { cwd, path: ".", literal: true, useIndex: true };
		const result = await run(
			"/bin/sh",
			[
				"-c",
				repositorySearchCommand({
					...search,
					query: "identifier",
				}),
			],
			{ env: { ...process.env, PATH: bin } },
		);
		expect(result.stdout).toBe("source.txt:1:identifier\n");
		expect(
			repositorySearchCommand({ ...search, literal: false, query: "foo.*bar" }),
		).not.toContain("python3");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
