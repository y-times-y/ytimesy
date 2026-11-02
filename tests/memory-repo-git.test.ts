import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import http from "isomorphic-git/http/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	MEMORY_LAYOUT_COMMIT,
	memoryLayoutChanges,
} from "#/domain/memory-layout";
import {
	EMPTY_MEMORY,
	memoryCloneScript,
	withMemoryChanges,
} from "#/domain/memory-repo";
import { pushChanges } from "#/server/adapters/memory-repos";

/**
 * The memory loop against real Git over smart HTTP (git http-backend):
 * the builder VM's clone script and the Worker's isomorphic-git writer.
 */
const run = promisify(execFile);
let root: string;
let server: Server;
let origin: string;
const TOKEN = "art_v1_test";

async function git(cwd: string, ...args: string[]) {
	return (await run("git", args, { cwd })).stdout.trim();
}

async function bareRepo(name: string) {
	await run("git", ["init", "-q", "--bare", "-b", "main", join(root, name)]);
	await git(join(root, name), "config", "http.receivepack", "true");
	return `${origin}/${name}`;
}

async function cloneScript(home: string, remote: string) {
	return run("bash", ["-c", memoryCloneScript({ remote, token: TOKEN })], {
		env: { ...process.env, HOME: home, GIT_TERMINAL_PROMPT: "0" },
	});
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "memory-git-"));
	const backend = (await run("git", ["--exec-path"])).stdout.trim();
	server = createServer((request, response) => {
		// Every request must carry the repo-scoped token, as Artifacts requires.
		if (request.headers.authorization !== `Bearer ${TOKEN}`) {
			response.writeHead(401).end();
			return;
		}
		const url = new URL(request.url ?? "/", "http://localhost");
		const child = spawn(join(backend, "git-http-backend"), {
			env: {
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: request.method ?? "GET",
				CONTENT_TYPE: request.headers["content-type"] ?? "",
				REMOTE_USER: "test",
				REMOTE_ADDR: "127.0.0.1",
			},
		});
		request.pipe(child.stdin);
		const chunks: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("close", () => {
			const output = Buffer.concat(chunks);
			const split = output.indexOf("\r\n\r\n");
			const head = output.subarray(0, split).toString();
			const headers: Record<string, string> = {};
			let status = 200;
			for (const line of head.split("\r\n")) {
				const [name, ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (name.toLowerCase() === "status")
					status = Number.parseInt(value, 10);
				else headers[name] = value;
			}
			response.writeHead(status, headers).end(output.subarray(split + 4));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	server?.close();
	await rm(root, { recursive: true, force: true });
});

describe("builder VM clone", () => {
	it("seeds an empty repo, clones it in a new chat, and makes git reject a conflicting push", async () => {
		const remote = await bareRepo("memory-a.git");
		const alice = await mkdtemp(join(root, "home-"));
		const other = await mkdtemp(join(root, "home-"));
		await cloneScript(alice, remote);
		expect(await readFile(join(alice, "memory/MEMORY.md"), "utf8")).toBe(
			EMPTY_MEMORY,
		);
		// The token lives only in the clone's own config, never in the remote URL.
		expect(
			await git(join(alice, "memory"), "remote", "get-url", "origin"),
		).toBe(remote);

		// A second chat (another VM) clones what the first pushed.
		await cloneScript(other, remote);
		expect(await git(join(other, "memory"), "log", "--format=%s")).toBe(
			"Create memory repo",
		);

		// Both chats edit the same line; the second push is rejected.
		const edit = async (home: string, line: string) => {
			const dir = join(home, "memory");
			await writeFile(
				join(dir, "MEMORY.md"),
				`# Memory\n\n${line}\n\n## Index\n`,
			);
			await git(dir, "commit", "-qam", line);
		};
		await edit(alice, "- Uses pnpm");
		await git(join(alice, "memory"), "push", "-q");
		await edit(other, "- Uses npm");
		await expect(git(join(other, "memory"), "push", "-q")).rejects.toThrow(
			/rejected|fetch first/,
		);
		// Pulling shows both versions; the agent writes one and pushes.
		await expect(git(join(other, "memory"), "pull", "-q")).rejects.toThrow(
			/conflict/i,
		);
		const conflicted = await readFile(join(other, "memory/MEMORY.md"), "utf8");
		expect(conflicted).toContain("- Uses pnpm");
		expect(conflicted).toContain("- Uses npm");
		await writeFile(
			join(other, "memory/MEMORY.md"),
			"# Memory\n\n- Uses pnpm (switched from npm)\n\n## Index\n",
		);
		await git(join(other, "memory"), "add", "MEMORY.md");
		await run("git", ["-C", join(other, "memory"), "rebase", "--continue"], {
			env: { ...process.env, GIT_EDITOR: "true" },
		});
		await git(join(other, "memory"), "push", "-q");

		// The next session refreshes a clean clone to the latest memory.
		await cloneScript(alice, remote);
		expect(await readFile(join(alice, "memory/MEMORY.md"), "utf8")).toContain(
			"switched from npm",
		);

		// The user clears memory (the repo is deleted and recreated empty): an
		// old clone starts over instead of pushing the cleared memory back.
		await rm(join(root, "memory-a.git"), { recursive: true, force: true });
		await bareRepo("memory-a.git");
		await cloneScript(alice, remote);
		expect(await readFile(join(alice, "memory/MEMORY.md"), "utf8")).toBe(
			EMPTY_MEMORY,
		);
		const check = await mkdtemp(join(root, "check-"));
		await run("git", ["clone", "-q", join(root, "memory-a.git"), check]);
		expect(await git(check, "log", "--format=%s")).toBe("Create memory repo");
		expect(await readFile(join(check, "MEMORY.md"), "utf8")).toBe(EMPTY_MEMORY);
	}, 60_000);

	it("leaves local memory alone when the remote is unreachable", async () => {
		const remote = await bareRepo("memory-c.git");
		const home = await mkdtemp(join(root, "home-"));
		await cloneScript(home, remote);
		await writeFile(join(home, "memory/notes.md"), "- unpushed\n");
		await expect(
			cloneScript(home, `${origin}/missing-repo.git`),
		).rejects.toThrow();
		expect(await readFile(join(home, "memory/notes.md"), "utf8")).toBe(
			"- unpushed\n",
		);
	}, 60_000);
});

describe("Worker writer", () => {
	it("commits to an empty repo, then reports a conflict on a file changed since its base", async () => {
		const remote = await bareRepo("memory-b.git");
		const first = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base: { head: null, files: {} },
			changes: [{ path: "MEMORY.md", content: EMPTY_MEMORY }],
			message: "Create memory repo",
		});
		expect(first).toMatchObject({ ok: true });
		const head = first !== "raced" && first.ok ? first.hash : null;
		const base = { head, files: { "MEMORY.md": EMPTY_MEMORY } };

		const dream = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base,
			changes: [{ path: "tooling.md", content: "# tooling\n- Uses pnpm\n" }],
			message: "Dream: tooling",
		});
		expect(dream).toMatchObject({ ok: true });

		// Same base, but a different file: no conflict, the commit goes on top.
		const unrelated = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base,
			changes: [
				{ path: "people.md", content: "# people\n- Priya owns pricing\n" },
			],
			message: "Save hook",
		});
		expect(unrelated).toMatchObject({ ok: true });

		// A writer whose view of tooling.md predates the dream must not overwrite it.
		const stale = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base,
			changes: [{ path: "tooling.md", content: "# tooling\n- Uses npm\n" }],
			message: "Stale write",
		});
		expect(stale).toMatchObject({ ok: false, reason: "conflict" });

		const check = await mkdtemp(join(root, "check-"));
		await run("git", ["clone", "-q", join(root, "memory-b.git"), check]);
		expect(await git(check, "log", "--format=%s")).toBe(
			"Save hook\nDream: tooling\nCreate memory repo",
		);
		expect(await readFile(join(check, "tooling.md"), "utf8")).toContain("pnpm");
	}, 60_000);
});

describe("layout migration on a real repo", () => {
	it("moves files in one commit that git revert undoes exactly", async () => {
		const remote = await bareRepo("memory-layout.git");
		const legacy = {
			"MEMORY.md": "# Memory\n\n## Index\n- [[tooling]]\n",
			"tooling.md":
				"# tooling\n- Prefers tabs [added: 2026-10-01]\n- Web pins Node 22 [project: acme/web; added: 2026-10-02]\n",
		};
		const seeded = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base: { head: null, files: {} },
			changes: Object.entries(legacy).map(([path, content]) => ({
				path,
				content,
			})),
			message: "Seed",
		});
		const head = seeded !== "raced" && seeded.ok ? seeded.hash : null;
		const changes =
			memoryLayoutChanges(legacy, [
				{ fullName: "acme/web", repositoryIds: [7] },
			]) ?? [];
		const moved = await pushChanges({
			http,
			remote,
			token: TOKEN,
			base: { head, files: legacy },
			changes,
			message: MEMORY_LAYOUT_COMMIT,
		});
		expect(moved).toMatchObject({ ok: true });
		const check = await mkdtemp(join(root, "layout-"));
		await run("git", ["clone", "-q", join(root, "memory-layout.git"), check]);
		expect(await git(check, "log", "--format=%s")).toBe(
			"Reorganize memory by project\nSeed",
		);
		const after = withMemoryChanges(legacy, changes);
		expect(await git(check, "ls-files")).toBe(
			[
				".memory-layout",
				"MEMORY.md",
				"personal/tooling.md",
				"projects/acme-web--7/tooling.md",
			].join("\n"),
		);
		expect(
			await readFile(join(check, "projects/acme-web--7/tooling.md"), "utf8"),
		).toBe(after["projects/acme-web--7/tooling.md"]);
		// Reversible: reverting the one commit restores the old tree byte for byte.
		await git(
			check,
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"revert",
			"--no-edit",
			"HEAD",
		);
		expect(await git(check, "diff", "--stat", "HEAD~2", "HEAD")).toBe("");
	}, 60_000);
});
