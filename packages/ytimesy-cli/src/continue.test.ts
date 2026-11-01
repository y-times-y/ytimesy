import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeFile,
	writeJsonl,
} from "../../../src/local-sessions/test-fixtures.ts";
import { main } from "./cli.ts";
import type { Io } from "./continue.ts";
import { type FakeServer, startFakeServer } from "./test-server.ts";

const CODE = "YTM-ABCD-EFGH-JKLM";
const SECRET = "sk-test-abcdefghijklmnop1234";
const READER_ENV = [
	"CODEX_HOME",
	"XDG_CONFIG_HOME",
	"CURSOR_CONFIG_DIR",
	"GEMINI_CLI_HOME",
	"APPDATA",
];

let base: string;
let home: string;
let repo: string;
let scratch: string;
let remotes: { app: string; scratch: string };
let env: Record<string, string | undefined>;
let server: FakeServer;
let savedEnv: Record<string, string | undefined>;
const projectId = randomUUID();

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function write(root: string, name: string, content: string) {
	fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
	fs.writeFileSync(path.join(root, name), content);
}

/** A small Claude Code session: a prompt, a reply and a passing shell command. */
function claudeSession(cwd: string, id: string, prompt: string) {
	const envelope = (extra: object) => ({
		cwd,
		sessionId: id,
		version: "2.1.296",
		gitBranch: "main",
		isSidechain: false,
		userType: "external",
		entrypoint: "cli",
		...extra,
	});
	writeJsonl(claudeFile(home, cwd, id), [
		envelope({
			type: "user",
			uuid: `${id}-u1`,
			message: { role: "user", content: prompt },
			origin: { kind: "human" },
			promptSource: "typed",
			timestamp: "2026-10-30T10:00:00.000Z",
		}),
		envelope({
			type: "assistant",
			uuid: `${id}-a1`,
			message: {
				id: `${id}-m1`,
				model: "claude-test-1",
				role: "assistant",
				content: [{ type: "text", text: "Working on it." }],
			},
			timestamp: "2026-10-30T10:00:05.000Z",
		}),
		envelope({
			type: "assistant",
			uuid: `${id}-a2`,
			message: {
				id: `${id}-m2`,
				model: "claude-test-1",
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: `${id}-t1`,
						name: "Bash",
						input: { command: "pnpm test" },
					},
				],
			},
			timestamp: "2026-10-30T10:00:06.000Z",
		}),
		envelope({
			type: "user",
			uuid: `${id}-u2`,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: `${id}-t1`,
						content: "passed",
						is_error: false,
					},
				],
			},
			toolUseResult: { stdout: "passed", stderr: "", interrupted: false },
			timestamp: "2026-10-30T10:00:09.000Z",
		}),
	]);
}

function io(output: string[], progress: string[] = []): Io {
	return {
		env,
		cwd: repo,
		home,
		stdout: (text) => output.push(text),
		stderr: (text) => progress.push(text),
		ancestors: () => [],
		version: "0.0.0-test",
	};
}

async function run(...args: string[]) {
	const output: string[] = [];
	const progress: string[] = [];
	const code = await main(
		["continue", "--code", CODE, "--api", server.url, ...args],
		io(output, progress),
	);
	return { code, output: output.join("\n"), progress: progress.join("\n") };
}

function routes() {
	return server.calls.map((call) => call.route);
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(
		READER_ENV.map((key) => [key, process.env[key]]),
	);
	for (const key of READER_ENV) delete process.env[key];
	base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "ytimesy-cli-")),
	);
	home = path.join(base, "home");
	repo = path.join(base, "work", "app");
	scratch = path.join(base, "work", "scratch");
	remotes = {
		app: path.join(base, "remotes", "app.git"),
		scratch: path.join(base, "remotes", "scratch.git"),
	};
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(scratch, { recursive: true });
	fs.writeFileSync(
		path.join(base, "gitconfig"),
		[
			"[user]",
			"\tname = Test",
			"\temail = test@example.com",
			"[init]",
			"\tdefaultBranch = main",
			`[url "${remotes.app}"]`,
			"\tinsteadOf = https://github.com/acme/app.git",
			`[url "${remotes.scratch}"]`,
			"\tinsteadOf = https://github.com/acme/scratch.git",
			"",
		].join("\n"),
	);
	env = {
		PATH: process.env.PATH,
		HOME: home,
		GIT_CONFIG_GLOBAL: path.join(base, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		YTIMESY_STATE_DIR: path.join(base, "state"),
		CLAUDECODE: "1",
		CLAUDE_CODE_SESSION_ID: "app-session",
	};
	git(base, "init", "--bare", "--quiet", remotes.app);
	git(base, "init", "--bare", "--quiet", remotes.scratch);
	git(repo, "init", "--quiet");
	write(repo, "src/app.ts", "export const a = 1;\n");
	write(repo, ".gitignore", "node_modules/\n");
	git(repo, "add", ".");
	git(repo, "commit", "--quiet", "-m", "first");
	git(repo, "remote", "add", "origin", "https://github.com/acme/app.git");
	git(repo, "push", "--quiet", "origin", "main");
	// Work in progress: a tracked change, an untracked file, secrets.
	write(repo, "src/app.ts", "export const a = 2;\n");
	write(repo, "notes.md", "next: wire the parser\n");
	write(repo, ".env", `API_KEY=${SECRET}\nPORT=3000\n`);
	write(
		repo,
		".env.local",
		'export DATABASE_URL="postgres://u:p4ssw0rd-long@db/x"\n',
	);
	write(scratch, "index.html", "<h1>scratch</h1>\n");

	claudeSession(repo, "app-session", `Use the key ${SECRET} to fix the parser`);
	claudeSession(scratch, "scratch-session", "Sketch a landing page");
	fs.utimesSync(
		claudeFile(home, scratch, "scratch-session"),
		new Date(Date.now() - 60_000),
		new Date(Date.now() - 60_000),
	);

	server = await startFakeServer({
		code: CODE,
		owner: "acme",
		projects: [{ id: projectId, name: "app", repositories: ["acme/app"] }],
		reachable: new Map([["acme/app", true]]),
		remotes: new Map([
			["acme/app", remotes.app],
			["acme/scratch", remotes.scratch],
		]),
	});
});

afterEach(async () => {
	await server.close();
	for (const [key, value] of Object.entries(savedEnv))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	fs.rmSync(base, { recursive: true, force: true });
});

describe("ytimesy continue", () => {
	it("plans, asks for decisions, imports, and replays the result on a re-run", async () => {
		const statusBefore = git(repo, "status", "--porcelain=v2", "--branch");

		// 1. Plan only: spends the code, uploads nothing.
		const plan = await run();
		expect(plan.code).toBe(0);
		expect(routes()).toEqual(["start", "plan"]);
		expect(server.calls[0]?.body).toMatchObject({
			code: CODE,
			agent: "claude",
		});
		const out = plan.output;
		expect(out).toContain("ytimesy import plan (called from Claude Code)");
		expect(out).toContain('This session: "Use the key [REDACTED]');
		expect(out).toMatch(
			/session {2}1 session, .* in 1 folder {2}\(default\) {2}<- shown below/,
		);
		expect(out).toMatch(/machine {2}2 sessions, .* in 2 folders/);
		expect(out).toContain('-> import into project "app"');
		expect(out).toContain("1 uncommitted tracked change");
		expect(out).toContain("1 untracked file to push (needs --yes-untracked)");
		expect(out).toContain("    notes.md");
		expect(out).toContain(".env (secret-like name)");
		expect(out).toContain(
			"Secrets from .env (values never shown; uploaded only with --secrets): API_KEY, PORT",
		);
		expect(out).toContain("Secrets from .env.local");
		expect(out).not.toContain(SECRET);
		expect(out).not.toContain("p4ssw0rd");
		expect(out).toMatch(
			/npx -y ytimesy continue --code YTM-ABCD-EFGH-JKLM --scope session --api http:\/\/127\.0\.0\.1:\d+ --yes-untracked/,
		);

		// 2. Machine scope without decisions: nothing happens, the needs are listed.
		const needs = await run("--scope", "machine");
		expect(needs.code).toBe(3);
		expect(needs.output).toContain("Needs the user's decision");
		expect(needs.output).toContain("--yes-untracked");
		// .env values are never uploaded without the user's choice.
		expect(needs.output).toContain("--secrets NAME,NAME or --no-secrets");
		expect(needs.output).toContain(
			`${scratch} has no GitHub repository: --create-repo ${scratch}=scratch or --attach ${scratch}=<project id> or --skip ${scratch}`,
		);
		expect(routes()).toEqual(["start", "plan", "plan"]);

		// 3. The import.
		const done = await run(
			"--scope",
			"machine",
			"--yes-untracked",
			"--create-repo",
			`${scratch}=scratch`,
			"--secrets",
			"API_KEY,PORT,DATABASE_URL",
			"--json",
		);
		expect(done.code, done.output).toBe(0);
		const report = JSON.parse(done.output);
		expect(report).toMatchObject({
			step: "done",
			repository: "acme/app",
			pushed: ["src/app.ts", "notes.md"],
			skipped: [
				{ path: ".env", reason: "secret-like name" },
				{ path: ".env.local", reason: "secret-like name" },
			],
			sessions: { uploaded: 2, alreadyUploaded: 0, failed: [] },
			secrets: ["API_KEY", "PORT", "DATABASE_URL"],
			createdRepositories: [{ repository: "acme/scratch" }],
		});
		expect(report.openUrl).toMatch(
			new RegExp(`^${server.url}/\\?project=${projectId}&chat=`),
		);
		expect(done.progress).toContain("Session 1/2");
		expect(routes()).toEqual([
			"start",
			"plan",
			"plan",
			"plan",
			"create-project",
			"secrets",
			"sessions",
			"transcript",
			"sessions",
			"transcript",
			"finish",
		]);
		expect(server.calls.at(-1)?.body).toMatchObject({
			projectId,
			continue: { tool: "claude", sessionId: "app-session" },
			branch: report.branch,
			repository: "acme/app",
			pushedFiles: 2,
			skippedFiles: 2,
		});

		// The branch has the work; the checkout is untouched.
		expect(report.branch).toMatch(/^ytimesy\/main-[0-9a-f]{4}$/);
		expect(git(remotes.app, "show", `${report.branch}:src/app.ts`)).toBe(
			"export const a = 2;",
		);
		expect(git(remotes.app, "show", `${report.branch}:notes.md`)).toBe(
			"next: wire the parser",
		);
		expect(() => git(remotes.app, "show", `${report.branch}:.env`)).toThrow();
		expect(git(repo, "status", "--porcelain=v2", "--branch")).toBe(
			statusBefore,
		);
		expect(git(remotes.scratch, "show", "main:index.html")).toBe(
			"<h1>scratch</h1>",
		);
		expect(fs.existsSync(path.join(scratch, ".git"))).toBe(false);

		// Uploads: valid handoffs, redacted, with transcripts.
		const uploaded = [...server.sessions.values()];
		expect(uploaded.map((session) => session.handoff.sessionId).sort()).toEqual(
			["app-session", "scratch-session"],
		);
		const app = uploaded.find(
			(session) => session.handoff.sessionId === "app-session",
		);
		expect(JSON.stringify(app?.handoff)).not.toContain(SECRET);
		expect(app?.handoff.turns[0]?.text).toBe(
			"Use the key [REDACTED] to fix the parser",
		);
		expect(app?.handoff.successfulCommands).toEqual(["pnpm test"]);
		const extracted = path.join(base, "extracted");
		fs.mkdirSync(extracted);
		fs.writeFileSync(path.join(base, "t.tgz"), app?.transcript as Buffer);
		execFileSync("tar", ["-xzf", path.join(base, "t.tgz"), "-C", extracted]);
		const transcript = fs.readFileSync(
			path.join(extracted, "transcript.md"),
			"utf8",
		);
		expect(transcript).toContain("[REDACTED]");
		expect(transcript).not.toContain(SECRET);
		expect(server.secrets).toEqual([
			{ projectId, names: ["API_KEY", "PORT", "DATABASE_URL"] },
		]);

		// 4. Re-running prints the same result without calling the server.
		const again = await run(
			"--scope",
			"machine",
			"--yes-untracked",
			"--create-repo",
			`${scratch}=scratch`,
			"--secrets",
			"API_KEY,PORT,DATABASE_URL",
		);
		expect(again.code).toBe(0);
		expect(again.output).toContain(`Done — open ${report.openUrl}`);
		expect(again.output).toContain("notes.md");
		expect(server.calls).toHaveLength(11);
	});

	it("resumes after a failed upload without redoing finished steps", async () => {
		await server.close();
		server = await startFakeServer({
			code: CODE,
			owner: "acme",
			projects: [{ id: projectId, name: "app", repositories: ["acme/app"] }],
			reachable: new Map([["acme/app", true]]),
			remotes: new Map([["acme/app", remotes.app]]),
			failures: [{ route: "transcript", call: 1, status: 500 }],
		});
		const failed = await run(
			"--scope",
			"session",
			"--no-untracked",
			"--secrets",
			"API_KEY,PORT,DATABASE_URL",
		);
		expect(failed.code).toBe(1);
		expect(failed.output).toContain(
			"Failed: The session being continued was not uploaded (Injected failure).",
		);
		expect(failed.output).toContain("Next: Re-run the same command");
		const branchSha = git(
			remotes.app,
			"for-each-ref",
			"--format=%(objectname)",
			"refs/heads/ytimesy/",
		);
		expect(branchSha).toMatch(/^[0-9a-f]{40}$/);

		// A later commit time would make a new commit; the pushed one is reused.
		env.GIT_COMMITTER_DATE = "2030-01-01T00:00:00Z";
		env.GIT_AUTHOR_DATE = "2030-01-01T00:00:00Z";
		const resumed = await run(
			"--scope",
			"session",
			"--no-untracked",
			"--secrets",
			"API_KEY,PORT,DATABASE_URL",
		);
		expect(resumed.code, resumed.output).toBe(0);
		expect(resumed.output).toContain("Done — open");
		expect(resumed.output).toContain("notes.md (untracked; --no-untracked)");
		expect(routes()).toEqual([
			"start",
			"plan",
			"secrets",
			"sessions",
			"transcript",
			"plan",
			"sessions",
			"transcript",
			"finish",
		]);
		expect(
			git(
				remotes.app,
				"for-each-ref",
				"--format=%(objectname)",
				"refs/heads/ytimesy/",
			),
		).toBe(branchSha);
	});

	it("continues the repository the command runs in, such as a worktree", async () => {
		const worktree = path.join(base, "work", "app-wt");
		git(repo, "worktree", "add", "--quiet", "-b", "wt-branch", worktree);
		write(worktree, "src/app.ts", "export const a = 3;\n");
		const output: string[] = [];
		const code = await main(["continue", "--code", CODE, "--api", server.url], {
			...io(output),
			cwd: worktree,
		});
		const text = output.join("\n");
		expect(code, text).toBe(0);
		expect(text).toContain(
			`folder ${worktree} (the session running this command)`,
		);
		expect(text).toContain(`${worktree} (this session) · acme/app (private)`);
		expect(text).toMatch(
			/Branch ytimesy\/wt-branch-[0-9a-f]{4} on acme\/app, from wt-branch/,
		);
		expect(text).toContain("    src/app.ts");
	});

	it("refuses an unknown folder and prints usage errors", async () => {
		const unknown = await run("--scope", "session", "--skip", "/nowhere");
		expect(unknown.code).toBe(2);
		expect(unknown.output).toContain(
			'No folder in this scope matches "/nowhere"',
		);
		const output: string[] = [];
		expect(await main(["continue"], io(output))).toBe(2);
		expect(output.join("\n")).toContain("Pass the code from ytimesy");
		expect(
			await main(["continue", "--code", CODE, "--scope", "galaxy"], io(output)),
		).toBe(2);
	});
});
