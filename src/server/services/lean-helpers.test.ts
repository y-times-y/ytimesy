import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { leanToolInstructions } from "#/domain/lean-tool-instructions";
import { agentTurnInstructions } from "./agent-turn-instructions";
import { commandRoot } from "./api-agent-command-tools";
import { compactApiHistory } from "./api-agent-context";
import {
	ensureLeanHelpers,
	environmentMarkdownCommand,
	historyText,
	LEAN_HELPER_COMMANDS,
	leanHelperBundle,
	writeLeanHistory,
} from "./lean-helpers";
import type { WorkspaceMachines } from "./workspace-machines";

let root: string;
let home: string;
let bin: string;

function sh(command: string, cwd = root) {
	return new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(done) =>
			execFile(
				"bash",
				["-c", command],
				{
					cwd,
					env: {
						...process.env,
						HOME: home,
						PATH: `${bin}:${process.env.PATH}`,
						PYTHONPATH: "",
					},
					maxBuffer: 64 * 1024 * 1024,
				},
				(error, stdout, stderr) =>
					done({
						exitCode:
							error && typeof error.code === "number"
								? error.code
								: error
									? 1
									: 0,
						stdout,
						stderr,
					}),
			),
	);
}

const exec = vi.fn((_vm: unknown, command: string) => sh(command));
const machines = {
	exec,
	writeTextFile: (_vm: unknown, path: string, contents: string) =>
		writeFile(path, contents),
} as unknown as WorkspaceMachines;
const workspace = { machines, vm: WorkspaceId("vm") };

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "lean-helpers-"));
	home = join(root, "home");
	bin = join(root, "bin");
	await mkdir(home);
	await mkdir(bin);
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("workspace commands", () => {
	it("installs ytimesy-check, ytimesy-browser and ytimesy-job once per version, with environment.md", async () => {
		const report = join(root, "environment.json");
		await writeFile(
			report,
			JSON.stringify({
				version: 1,
				repositories: [
					{
						fullName: "owner/app",
						branch: "main",
						directory: "/work/app",
						recipe: { version: 1, checks: ["npm test"] },
						checkResults: [{ command: "npm test", exitCode: 1 }],
					},
				],
			}),
		);
		const options = { linkDirectory: bin, environmentReport: report };
		await ensureLeanHelpers(workspace, "session-1", options);
		for (const name of LEAN_HELPER_COMMANDS)
			expect((await sh(`command -v ${name}`)).stdout.trim()).toBe(
				join(bin, name),
			);
		const environment = await readFile(
			join(home, ".ytimesy/environment.md"),
			"utf8",
		);
		expect(environment).toContain("## owner/app");
		expect(environment).toContain("- baseline check `npm test`: exit 1");
		expect(environment).toContain('"fullName":"owner/app"');
		expect(await readdir(join(home, ".ytimesy/history"))).toEqual([]);
		// Installed already: one small check, no reinstall.
		exec.mockClear();
		await ensureLeanHelpers(workspace, "session-1", options);
		expect(exec).toHaveBeenCalledTimes(1);
		// A new version (different session baked into ytimesy-browser) reinstalls.
		expect(leanHelperBundle("session-2").marker).not.toBe(
			leanHelperBundle("session-1").marker,
		);
	});

	it("ytimesy-check runs the deliverable from a clean copy, like check_deliverable", async () => {
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(
			join(project, "run.py"),
			"print(open('data.txt').read().strip())\n",
		);
		await sh(
			"git init -q && git add run.py && git -c user.name=t -c user.email=t@example.invalid commit -qm init",
			project,
		);
		await writeFile(join(project, "data.txt"), "secret sauce\n");
		const missing = await sh(
			"ytimesy-check --files run.py -- python3 run.py",
			project,
		);
		expect(missing.exitCode).toBe(1);
		expect(missing.stdout).toMatch(
			/^FAILED: clean-copy run of "python3 run.py"/,
		);
		const report = JSON.parse(
			missing.stdout.slice(missing.stdout.indexOf("\n")),
		);
		expect(report.problems).toContainEqual(
			expect.objectContaining({ kind: "missing-file", path: "data.txt" }),
		);
		const passing = await sh(
			"ytimesy-check --files run.py data.txt --timeout 60 -- python3 run.py",
			project,
		);
		expect(passing.exitCode).toBe(0);
		expect(passing.stdout).toMatch(/^PASSED/);
		expect(passing.stdout).toContain("secret sauce");
		const usage = await sh("ytimesy-check --files run.py", project);
		expect(usage.exitCode).toBe(2);
		expect(usage.stderr).toContain("usage: ytimesy-check");
		// Outside Git only the listed files are delivered, so data the run reads
		// must be one the task names.
		await rm(join(project, ".git"), { recursive: true });
		const unnamed = await sh(
			"ytimesy-check --files run.py data.txt -- python3 run.py",
			project,
		);
		expect(unnamed.exitCode).toBe(1);
		expect(unnamed.stdout).toContain('"kind": "undeclared-by-task"');
		const named = await sh(
			"ytimesy-check --files run.py data.txt --named-data data.txt -- python3 run.py",
			project,
		);
		expect(named.exitCode).toBe(0);
	});

	it("ytimesy-browser and ytimesy-job are valid scripts with usage errors", async () => {
		for (const name of ["ytimesy-browser", "ytimesy-job"]) {
			expect((await sh(`bash -n "$(command -v ${name})"`)).exitCode).toBe(0);
			expect((await sh(name)).exitCode).toBe(2);
		}
		expect((await sh("ytimesy-browser 2>&1")).stdout).toContain(
			"ytimesy-browser screenshot",
		);
		const unknown = await sh(
			"ytimesy-job status 00000000-0000-4000-8000-000000000000",
		);
		expect(unknown.exitCode).toBe(2);
		expect(unknown.stderr).toContain("not a command of this session");
	});

	it("ytimesy-job reads this session's command files and stop records 130 like stop_command", async () => {
		const id = randomUUID();
		const commands = commandRoot("session-1");
		await mkdir(commands, { recursive: true });
		try {
			await writeFile(join(commands, `${id}.output`), "hello\n");
			const status = await sh(`ytimesy-job status ${id}`);
			expect(status.stdout).toContain("interrupted");
			expect(status.stdout).toContain("hello");
			const stop = await sh(`ytimesy-job stop ${id}`);
			expect(stop.stdout).toContain(`stopped ${id} (exit 130)`);
			expect(await readFile(join(commands, `${id}.status`), "utf8")).toBe(
				"130\n",
			);
			expect((await sh(`ytimesy-job status ${id}`)).stdout).toContain(
				"exited: 130",
			);
		} finally {
			await rm(join(commands, `${id}.output`), { force: true });
			await rm(join(commands, `${id}.status`), { force: true });
		}
	});

	it("does not touch environment.md without a report", async () => {
		const command = environmentMarkdownCommand(join(root, "absent.json"));
		expect((await sh(command)).exitCode).toBe(0);
	});
});

describe("conversation history files", () => {
	const messages: ModelMessage[] = [
		{ role: "user", content: "Fix the flaky retry test" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Looking at retry.ts" },
				{
					type: "tool-call",
					toolCallId: "c1",
					toolName: "Bash",
					input: { command: "rg -n backoffMs src" },
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "Bash",
					output: {
						type: "text",
						value: "src/retry.ts:12: const backoffMs = 250;",
					},
				},
			],
		},
	];

	it("renders archived messages as searchable text", () => {
		const text = historyText(messages, "context-1");
		expect(text).toContain("## 1. user\n\nFix the flaky retry test");
		expect(text).toContain(
			'[tool call Bash c1] {"command":"rg -n backoffMs src"}',
		);
		expect(text).toContain(
			"[tool result Bash c1]\nsrc/retry.ts:12: const backoffMs = 250;",
		);
	});

	it("writes them to ~/.ytimesy/history/ and cites that path in the compacted summary", async () => {
		const path = await writeLeanHistory(workspace, "context-abc", messages);
		expect(path).toMatch(
			/^~\/\.ytimesy\/history\/\d{8}T\d{6}-context-abc\.md$/,
		);
		const file = join(home, path.slice(2));
		expect(await readFile(file, "utf8")).toContain("backoffMs = 250");
		expect((await sh(`rg -l backoffMs ~/.ytimesy/history/`)).stdout).toContain(
			"context-abc.md",
		);
		const long: ModelMessage[] = [
			{ role: "user", content: "Old task" },
			{ role: "assistant", content: "Earlier decision ".repeat(7000) },
			{ role: "user", content: "Continue" },
		];
		const result = await compactApiHistory(
			long,
			async () => "Earlier work summarized.",
			undefined,
			async () => ({ file: path }),
		);
		const summary = JSON.stringify(result.messages);
		expect(summary).toContain(`saved in ${path}`);
		expect(summary).not.toContain("read_context_archive");
	});
});

describe("lean instructions", () => {
	it("follow the documented wording with each shape's tool names", () => {
		const claude = leanToolInstructions("claude");
		expect(claude).toContain(
			"Your tools: Bash runs shell commands; Edit and Write change files",
		);
		expect(claude).toContain(
			"`ytimesy-check --files <delivered paths> [--input <paths they supply>] [--unprivileged] -- <run command>`: when you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run it once before finishing with what they receive (when the task names its delivered files, exactly those: not data files or helpers your code loads that it does not name) and the documented command (--unprivileged when the task mentions another user or dropped privileges); it runs your deliverable from a clean copy. Fix what it reports. Skip it for edits to an existing project whose own tests you ran.",
		);
		expect(claude).toContain("`~/.ytimesy/history/`");
		expect(claude).toContain("`~/.ytimesy/environment.md` (if present)");
		expect(claude).toContain("`ytimesy-browser open|screenshot|inspect|exec`");
		expect(leanToolInstructions("codex")).toContain(
			"apply_patch changes files",
		);
		expect(leanToolInstructions("qwen")).toContain("edit and write_file");
		expect(leanToolInstructions("core")).toContain("tmux new -d");
	});

	it("replace the builder's tool-specific system prompt", () => {
		const input = {
			shellBuilder: true,
			session: { parentSessionId: null, taskAccess: null },
			tools: {},
			plugins: [],
			projectKnowledge: null,
		};
		const current = agentTurnInstructions(input);
		const lean = agentTurnInstructions({ ...input, leanShape: "gemini" });
		expect(current).toContain("read_environment_report");
		expect(lean).not.toContain("read_environment_report");
		expect(lean).toContain("run_shell_command runs shell commands");
		expect(lean).toContain("You are the coding agent for this chat");
		expect(lean).toContain("`ytimesy-browser screenshot`");
		expect(lean).toContain("look at the PNG it prints with read_file");
		expect(lean.length).toBeLessThan(current.length + 1800);
		const knowing = agentTurnInstructions({
			...input,
			projectKnowledge: "Billing lives in billing/.",
			leanShape: "core",
		});
		expect(knowing).toContain("Shared project knowledge");
		expect(knowing).toContain("Billing lives in billing/.");
		expect(knowing).not.toContain("search_project_memory");
		const located = agentTurnInstructions({
			...input,
			leanShape: "claude",
			leanWorkingDirectory: "/home/ubuntu/repo",
		});
		expect(located).toContain(
			"prepared repository checkout at /home/ubuntu/repo;",
		);
		expect(located).toContain(
			"Tools that take absolute paths need paths under /home/ubuntu/repo.",
		);
		expect(lean).not.toContain(" at /");
	});
});
