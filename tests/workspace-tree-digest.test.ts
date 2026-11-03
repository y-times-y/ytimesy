import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	parseTreeDigest,
	RecycleDeferred,
	retainedTreeDigest,
	treeDigestCommand,
} from "../src/server/adapters/freestyle/workspace-retention";

// The digest runs in the guest (Ubuntu: dash, GNU find and coreutils). Run
// it the same way: natively on Linux, else in a throwaway Ubuntu container.
const native =
	process.platform === "linux" &&
	spawnSync("find", ["--version"]).stdout?.toString().includes("GNU");
const docker =
	!native && spawnSync("docker", ["info"], { timeout: 10_000 }).status === 0;
let container: string | undefined;

function sh(script: string) {
	const result = native
		? spawnSync("sh", ["-c", script])
		: spawnSync("docker", ["exec", container as string, "sh", "-c", script]);
	return {
		statusCode: result.status,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const vm = {
	exec: async (input: { command: string }) => sh(input.command),
} as unknown as Parameters<typeof retainedTreeDigest>[0];

describe.skipIf(!native && !docker)("in-guest tree digest", () => {
	const base = native ? `/tmp/ytimesy-digest-${randomUUID()}` : "/work";
	const root = `${base}/repo`;
	const other = `${base}/other`;
	const build = `rm -rf ${base} && mkdir -p ${root}/src/deep ${root}/.git ${other} && cd ${root} && printf 'hello' > a.txt && printf 'x' > src/b.ts && printf '\\000\\001\\377' > src/deep/bin && printf 'SECRET=1' > .env && printf 'ref' > .git/HEAD && touch empty && mkdir emptydir && chmod 600 .env && printf 'o' > ${other}/o`;
	const digest = (roots = [root]) => retainedTreeDigest(vm, roots);

	beforeAll(() => {
		if (docker)
			container = execFileSync("docker", [
				"run",
				"-d",
				"--rm",
				"ubuntu:24.04",
				"sleep",
				"600",
			])
				.toString()
				.trim();
	}, 60_000);
	afterAll(() => {
		if (container) spawnSync("docker", ["rm", "-f", container]);
		if (native) spawnSync("rm", ["-rf", base]);
	});

	it("is the same for an identical tree rebuilt from scratch, and covers ignored files", async () => {
		sh(build);
		const first = await digest();
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		sh(`sleep 1; ${build}`);
		expect(await digest()).toBe(first);
		// Root order does not matter.
		expect(await digest([other, root])).toBe(await digest([root, other]));
		const out = parseTreeDigest(sh(treeDigestCommand([root])));
		// 5 directories (root, src, src/deep, .git, emptydir) and 6 files.
		expect(out.entries).toBe(11);
		expect(out.bytes).toBe(5 + 1 + 3 + 8 + 3);
	});

	it.each([
		["content", `printf 'hellO' > ${root}/a.txt`],
		["ignored content", `printf 'SECRET=2' > ${root}/.env`],
		["binary content", `printf '\\000\\001\\376' > ${root}/src/deep/bin`],
		["file mode", `chmod 755 ${root}/a.txt`],
		["directory mode", `chmod 700 ${root}/src`],
		["path", `mv ${root}/a.txt ${root}/c.txt`],
		["new empty file", `touch ${root}/src/new`],
		["new empty directory", `mkdir ${root}/src/newdir`],
		["removed empty directory", `rmdir ${root}/emptydir`],
		["owner", `chown 1000 ${root}/a.txt`],
	])("differs on a %s change", async (_label, change) => {
		sh(build);
		const before = await digest();
		const changed = sh(change);
		expect(changed.statusCode).toBe(0);
		expect(await digest()).not.toBe(before);
	});

	// What `npm ci` leaves behind: relative links in node_modules/.bin, plus
	// absolute and dangling links. Covered by their target text, never followed.
	const links = `cd ${root} && mkdir -p node_modules/.bin node_modules/vite/bin && printf 'js' > node_modules/vite/bin/vite.js && ln -s ../vite/bin/vite.js node_modules/.bin/vite && ln -s /etc/hostname abs && ln -s /nowhere dangling && ln -s src dirlink`;

	it("covers symlinks exactly: same tree, same digest, without following them", async () => {
		sh(build);
		const plain = await digest();
		sh(links);
		const linked = await digest();
		expect(linked).not.toBe(plain);
		sh(`sleep 1; ${build} && ${links}`);
		expect(await digest()).toBe(linked);
		// A linked directory is not walked, and a target's content is not read.
		const out = parseTreeDigest(sh(treeDigestCommand([root])));
		// 4 new directories, 1 file and 4 links.
		expect(out.entries).toBe(11 + 4 + 1 + 4);
		expect(out.bytes).toBe(5 + 1 + 3 + 8 + 3 + 2);
		sh("echo changed-host > /etc/hostname 2>/dev/null || true");
		expect(await digest()).toBe(linked);
	});

	it.each([
		[
			"link target",
			`ln -sfn ../vite/bin/other.js ${root}/node_modules/.bin/vite`,
		],
		["link path", `mv ${root}/abs ${root}/abs2`],
		["link owner", `chown -h 1000 ${root}/abs`],
		[
			"link to file swap",
			`rm ${root}/dangling && printf '/nowhere' > ${root}/dangling`,
		],
		[
			"links swapped",
			`ln -sfn /nowhere ${root}/abs && ln -sfn /etc/hostname ${root}/dangling`,
		],
	])("differs on a %s change", async (_label, change) => {
		sh(`${build} && ${links}`);
		const before = await digest();
		expect(sh(change).statusCode).toBe(0);
		expect(await digest()).not.toBe(before);
	});

	it.each([
		[
			"a symlinked root",
			`mv ${root} ${base}/real && ln -s ${base}/real ${root}`,
			"symlinked project root",
			"symlinked-root",
		],
		["a fifo", `mkfifo ${root}/src/pipe`, "special file", "special-file"],
		[
			"a socket",
			`python3 -c "import socket; s=socket.socket(socket.AF_UNIX); s.bind('${root}/sock')" 2>/dev/null || mkfifo ${root}/sock`,
			"special file",
			"special-file",
		],
		["a missing root", `rm -rf ${root}`, "could not read", "unreadable"],
	])(
		"refuses %s and keeps the source VM",
		async (_label, change, reason, category) => {
			sh(build);
			expect(sh(change).statusCode).toBe(0);
			const failure = digest().catch((error) => error);
			expect(await failure).toBeInstanceOf(RecycleDeferred);
			expect((await failure).message).toContain(reason);
			expect((await failure).category).toBe(category);
		},
	);

	it("handles spaces and newlines in names without ambiguity", async () => {
		sh(build);
		sh(`printf 'z' > "${root}/a b"`);
		const spaced = await digest();
		sh(`rm "${root}/a b" && printf 'z' > "${root}/a
b"`);
		const newline = await digest();
		expect(newline).not.toBe(spaced);
		expect(await digest()).toBe(newline);
	});
});

it("maps timeouts and odd output to a deferral, never a digest", () => {
	expect(() => parseTreeDigest({ statusCode: null })).toThrow("time budget");
	expect(() => parseTreeDigest({ statusCode: 0, stdout: "garbage" })).toThrow(
		RecycleDeferred,
	);
	expect(() => parseTreeDigest({ statusCode: 2, stdout: "" })).toThrow(
		"exit 2",
	);
	expect(
		parseTreeDigest({
			statusCode: 0,
			stdout: `ytimesy-tree-v2 3 7 ${"a".repeat(64)}\n`,
		}),
	).toEqual({ digest: "a".repeat(64), entries: 3, bytes: 7 });
});

it("only accepts plain absolute roots", () => {
	for (const bad of [
		"relative",
		"/home/ubuntu/x'y",
		"/home/../etc",
		"/a b",
		"",
	])
		expect(() => treeDigestCommand([bad])).toThrow("Invalid recovery");
	expect(() => treeDigestCommand([])).toThrow();
});
