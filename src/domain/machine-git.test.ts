import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	GIT_GRANT_USERNAME,
	gitGrantPassword,
	issueMachineGitGrant,
	type MachineGitGrant,
	proxyGithubGit,
} from "./github-git-proxy";
import {
	MACHINE_GIT_GRANT_ROUTE,
	machineGitReleaseScript,
	machineGitSetupScript,
	SCRUB_MACHINE_GIT_CREDENTIAL,
} from "./machine-git";

/**
 * Real git, the real helper and config, the real proxy: a local HTTP server
 * plays the edge (grant endpoint and /git/), and `git http-backend` on a
 * bare repository plays GitHub.
 */
const SECRET = "machine-git-test-secret-0123456789abcdef";
const SESSION = "00000000-0000-4000-8000-0000000000aa";
const TOKEN = `ygm_${"1".repeat(64)}`;
const TERMINAL_TOKEN = `ygm_${"2".repeat(64)}`;
const TERMINAL = `${SESSION}-terminal-${"c".repeat(16)}`;
const root = mkdtempSync(join(tmpdir(), "ytimesy-machine-git-"));
const home = join(root, "home");
const github = join(root, "github");
let server: Server;
let origin = "";
/** What the grant endpoint was asked for, in order. */
const grantsAsked: string[] = [];
let tokenValid = true;
let defaultBranchApproved = false;
const refusedPushes: string[] = [];
const spentNonces = new Set<string>();

/** A command run without blocking: the edge below serves it from this process. */
function run(
	command: string,
	args: string[],
	options: { cwd?: string; input?: string } = {},
) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolve, reject) => {
			const child = spawn(command, args, {
				cwd: options.cwd ?? root,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			// Git may refuse credentials and exit before consuming the complete body.
			child.stdin.on("error", (error: NodeJS.ErrnoException) => {
				if (error.code !== "EPIPE") reject(error);
			});
			child.on("error", reject);
			child.stdin.end(options.input ?? "");
			child.on("close", (status) => resolve({ status, stdout, stderr }));
		},
	);
}

const git = (args: string[], cwd = root) => run("git", args, { cwd });

/** `git http-backend` as GitHub: CGI in, an HTTP response out. */
async function githubBackend(target: string, init: RequestInit) {
	const url = new URL(target);
	const headers = new Headers(init.headers);
	const body = init.body
		? Buffer.from(await new Response(init.body as BodyInit).arrayBuffer())
		: Buffer.alloc(0);
	const child = spawn("git", ["http-backend"], {
		env: {
			PATH: process.env.PATH,
			GIT_PROJECT_ROOT: github,
			GIT_HTTP_EXPORT_ALL: "1",
			REMOTE_USER: "proxy",
			PATH_INFO: url.pathname,
			QUERY_STRING: url.search.slice(1),
			REQUEST_METHOD: init.method ?? "GET",
			CONTENT_TYPE: headers.get("content-type") ?? "",
			CONTENT_LENGTH: String(body.length),
			GIT_PROTOCOL: headers.get("git-protocol") ?? "",
		},
	});
	child.stdin.end(body);
	const chunks: Buffer[] = [];
	for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
	const output = Buffer.concat(chunks);
	const split = output.indexOf("\r\n\r\n");
	const head = output.subarray(0, split).toString();
	const status = /^Status: (\d+)/m.exec(head);
	const type = /^Content-Type: (.+)$/im.exec(head);
	return new Response(output.subarray(split + 4), {
		status: status ? Number(status[1]) : 200,
		headers: type ? { "content-type": type[1].trim() } : {},
	});
}

async function edge(request: Request) {
	const url = new URL(request.url);
	if (url.pathname === MACHINE_GIT_GRANT_ROUTE) {
		const bearer = request.headers.get("authorization");
		const terminal = bearer === `Bearer ${TERMINAL_TOKEN}`;
		if (!tokenValid || (bearer !== `Bearer ${TOKEN}` && !terminal))
			return Response.json({ error: "token expired" }, { status: 401 });
		const input = (await request.json()) as {
			owner: string;
			name: string;
			access: "read" | "write";
		};
		grantsAsked.push(`${input.access} ${input.owner}/${input.name}`);
		if (input.name === "private-elsewhere")
			return Response.json(
				{ error: "The ytimesy GitHub App cannot reach it." },
				{ status: 403 },
			);
		const headers = await issueMachineGitGrant(SECRET, {
			userId: "u1",
			sessionId: SESSION,
			projectId: "00000000-0000-4000-8000-000000000001",
			owner: input.owner,
			name: input.name,
			installationId: 7,
			access: input.access,
			...(terminal ? { holder: "terminal" as const } : {}),
		});
		return Response.json({
			username: GIT_GRANT_USERNAME,
			password: gitGrantPassword(headers),
		});
	}
	return proxyGithubGit(
		request,
		SECRET,
		async () => null,
		githubBackend as typeof fetch,
		async (nonce) => {
			if (spentNonces.has(nonce)) return false;
			spentNonces.add(nonce);
			return true;
		},
		{
			authorize: async (grant: MachineGitGrant) => ({
				token: grant.access === "write" ? "write-token" : null,
				defaultBranch: "main",
			}),
			defaultBranchPush: async (_grant, update) => {
				if (defaultBranchApproved) return true;
				refusedPushes.push(update.newId);
				return false;
			},
		},
	);
}

beforeAll(async () => {
	mkdirSync(home);
	mkdirSync(join(github, "owner"), { recursive: true });
	const seed = join(root, "seed");
	execFileSync("git", ["init", "-q", "-b", "main", seed]);
	execFileSync("git", [
		"-C",
		seed,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"seed",
	]);
	execFileSync("git", [
		"clone",
		"-q",
		"--bare",
		seed,
		join(github, "owner/repo.git"),
	]);
	server = createServer(async (incoming, outgoing) => {
		const request = new Request(
			`http://${incoming.headers.host}${incoming.url}`,
			{
				method: incoming.method,
				headers: incoming.headers as Record<string, string>,
				body:
					incoming.method === "GET" || incoming.method === "HEAD"
						? undefined
						: (Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
				duplex: "half",
			} as RequestInit,
		);
		const response = await edge(request);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const setup = spawnSync(
		"sh",
		["-c", machineGitSetupScript({ origin, holder: SESSION, token: TOKEN })],
		{ env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" },
	);
	expect(setup.stderr).toBe("");
	expect(setup.status).toBe(0);
});

afterAll(async () => {
	await new Promise((resolve) => server?.close(resolve));
	rmSync(root, { recursive: true, force: true });
});

describe("plain git on a workspace VM", async () => {
	const work = join(root, "work");

	it("is set up privately and only once in the global config", async () => {
		const again = spawnSync(
			"sh",
			["-c", machineGitSetupScript({ origin, holder: SESSION, token: TOKEN })],
			{ env: { PATH: process.env.PATH, HOME: home } },
		);
		expect(again.status).toBe(0);
		expect(
			(
				await git(["config", "--global", "--get-all", "include.path"])
			).stdout.trim(),
		).toBe("~/.ytimesy-git/config");
		const mode = (path: string) =>
			execFileSync("stat", ["-f", "%Lp", join(home, ".ytimesy-git", path)], {
				encoding: "utf8",
			}).trim();
		if (process.platform === "darwin") {
			expect(mode("")).toBe("700");
			expect(mode(`tokens/${SESSION}`)).toBe("600");
		}
		expect(
			readFileSync(join(home, ".ytimesy-git/tokens", SESSION), "utf8"),
		).toBe(TOKEN);
		// The token never lands in a git config.
		expect(readFileSync(join(home, ".gitconfig"), "utf8")).not.toContain(TOKEN);
		expect(
			readFileSync(join(home, ".ytimesy-git/config"), "utf8"),
		).not.toContain(TOKEN);
	});

	it("clones a github.com URL through the proxy with a read grant", async () => {
		grantsAsked.length = 0;
		const clone = await git([
			"clone",
			"-q",
			"https://github.com/owner/repo",
			work,
		]);
		expect(clone.stderr).toBe("");
		expect(clone.status).toBe(0);
		expect(grantsAsked).toEqual(["read owner/repo"]);
		expect(
			(await git(["config", "remote.origin.url"], work)).stdout.trim(),
		).toBe("https://github.com/owner/repo");
	});

	it("fetches an SSH-style URL the same way", async () => {
		const listed = await git([
			"ls-remote",
			"git@github.com:owner/repo.git",
			"main",
		]);
		expect(listed.status).toBe(0);
		expect(listed.stdout).toContain("refs/heads/main");
	});

	it("pushes and force-pushes the agent's own branch with a write grant", async () => {
		grantsAsked.length = 0;
		const commit = (message: string) =>
			git(
				[
					"-c",
					"user.name=a",
					"-c",
					"user.email=a@a",
					"commit",
					"-q",
					"--allow-empty",
					"-m",
					message,
				],
				work,
			);
		await commit("one");
		expect(
			(await git(["push", "-q", "origin", "HEAD:refs/heads/feature"], work))
				.status,
		).toBe(0);
		expect(grantsAsked).toEqual(["write owner/repo"]);
		await git(["reset", "-q", "--hard", "HEAD~1"], work);
		await commit("rewritten");
		const forced = await git(
			["push", "-q", "-f", "origin", "HEAD:feature"],
			work,
		);
		expect(forced.stderr).toBe("");
		expect(forced.status).toBe(0);
		expect(
			execFileSync(
				"git",
				[
					"-C",
					join(github, "owner/repo.git"),
					"log",
					"-1",
					"--format=%s",
					"feature",
				],
				{
					encoding: "utf8",
				},
			).trim(),
		).toBe("rewritten");
	});

	it("refuses deleting a branch in git's own words", async () => {
		const deleted = await git(["push", "origin", ":feature"], work);
		expect(deleted.status).not.toBe(0);
		expect(deleted.stderr).toContain("deleting branches is not allowed");
	});

	it("refuses main until the user approves that push, then pushes it", async () => {
		const head = (await git(["rev-parse", "HEAD"], work)).stdout.trim();
		const refused = await git(["push", "origin", "HEAD:main"], work);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("[remote rejected]");
		expect(refused.stderr).toContain("remote: Call request_push_approval");
		expect(refusedPushes).toEqual([head]);
		defaultBranchApproved = true;
		const approved = await git(["push", "-q", "origin", "HEAD:main"], work);
		expect(approved.stderr).toBe("");
		expect(approved.status).toBe(0);
	});

	it("tells the agent why when the edge refuses, and stops git from prompting", async () => {
		const listed = await git([
			"ls-remote",
			"https://github.com/owner/private-elsewhere",
		]);
		expect(listed.status).not.toBe(0);
		expect(listed.stderr).toContain(
			"ytimesy: The ytimesy GitHub App cannot reach it.",
		);
	});

	const helper = (input: string) =>
		run(join(home, ".ytimesy-git/credential-helper"), ["get"], { input });

	it("asks for a write grant first when git does not say which (git before 2.41)", async () => {
		grantsAsked.length = 0;
		const answer = await helper(
			"protocol=http\nhost=x\npath=git/owner/repo.git\n\n",
		);
		expect(answer.stdout).toMatch(
			/^username=ytimesy-grant\npassword=[A-Za-z0-9_-]+\n$/,
		);
		expect(grantsAsked).toEqual(["write owner/repo"]);
		const refused = await helper("path=git/owner/private-elsewhere\n\n");
		expect(refused.stdout).toBe("quit=1\n");
		expect(refused.stderr).toContain("cannot reach it");
	});

	it("refuses paths that are not owner/name", async () => {
		for (const path of [
			"git/owner",
			"other/owner/repo",
			"git/../x/y",
			"git/a/b/c",
		])
			expect((await helper(`path=${path}\n\n`)).stdout).toBe("quit=1\n");
	});

	it("says the credentials arrive with the next step when the token expired", async () => {
		tokenValid = false;
		const answer = await helper(
			'path=git/owner/repo\nwwwauth[]=Basic realm="ytimesy git fetch"\n\n',
		);
		tokenValid = true;
		expect(answer.stdout).toBe("quit=1\n");
		expect(answer.stderr).toContain("token expired");
	});

	it("keeps the user's terminal working after the turn's release, and points its main push at the chat", async () => {
		const env = { PATH: process.env.PATH, HOME: home };
		const tokens = join(home, ".ytimesy-git/tokens");
		expect(
			spawnSync(
				"sh",
				[
					"-c",
					machineGitSetupScript({
						origin,
						holder: TERMINAL,
						token: TERMINAL_TOKEN,
					}),
				],
				{ env },
			).status,
		).toBe(0);
		// The turn's step ends: its token goes, the terminal's and the config stay.
		spawnSync("sh", ["-c", machineGitReleaseScript(SESSION)], { env });
		expect(existsSync(join(tokens, SESSION))).toBe(false);
		expect(existsSync(join(tokens, TERMINAL))).toBe(true);
		expect(existsSync(join(home, ".ytimesy-git/config"))).toBe(true);
		defaultBranchApproved = false;
		await git(
			[
				"-c",
				"user.name=u",
				"-c",
				"user.email=u@u",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"from the terminal",
			],
			work,
		);
		expect(
			(await git(["push", "-q", "origin", "HEAD:feature-2"], work)).status,
		).toBe(0);
		const refused = await git(["push", "origin", "HEAD:main"], work);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("remote: Ask the agent in this chat");
		expect(refused.stderr).toContain('"Allow pushes to main without asking"');
		expect(refused.stderr).not.toContain("request_push_approval");
		// A holder that never released (e.g. a dropped terminal) is cleared as stale.
		const stale = `${SESSION.slice(0, -2)}bb`;
		writeFileSync(join(tokens, stale), "ygm_old");
		execFileSync("touch", ["-t", "202001010000", join(tokens, stale)]);
		spawnSync("sh", ["-c", machineGitReleaseScript(TERMINAL)], { env });
		expect(existsSync(join(tokens, stale))).toBe(false);
		expect(existsSync(join(home, ".ytimesy-git/config"))).toBe(false);
	});

	it("removes the chat's token and, with the last one, the config; the scrub removes all", async () => {
		const env = { PATH: process.env.PATH, HOME: home };
		spawnSync("sh", ["-c", machineGitReleaseScript(SESSION)], { env });
		expect(() => readFileSync(join(home, ".ytimesy-git/config"))).toThrow();
		expect((await helper("path=git/owner/repo\n\n")).stderr).toContain(
			"no git credentials right now",
		);
		spawnSync(
			"sh",
			["-c", machineGitSetupScript({ origin, holder: SESSION, token: TOKEN })],
			{ env },
		);
		const scrub = spawnSync("sh", ["-c", SCRUB_MACHINE_GIT_CREDENTIAL], {
			env,
		});
		expect(scrub.status).toBe(0);
		expect(() =>
			readFileSync(join(home, ".ytimesy-git/tokens", SESSION)),
		).toThrow();
		expect(() => readFileSync(join(home, ".ytimesy-git/config"))).toThrow();
		// Without a workspace git config, the scrub still passes.
		expect(
			spawnSync("sh", ["-c", SCRUB_MACHINE_GIT_CREDENTIAL], { env }).status,
		).toBe(0);
	});
});
