import { execFile, execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeApiUnavailable,
	ClaudeCodeRunFailure,
	ClaudeRunnerTransportFailure,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "#/domain/api-turn-failure";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "#/domain/claude-agent-runner";
import { verifyClaudeCodeGrant } from "#/domain/claude-code-grant";
import { claudeCodeProjectDirectory } from "#/domain/claude-code-stream";
import {
	CLAUDE_CODE_FEED_PATH,
	type ClaudeFeedState,
} from "#/domain/claude-feed";
import type { DirectTranscriptStore } from "#/domain/direct-transcript";
import { CLAUDE_AGENT_SDK_MODULE } from "#/domain/guest-cli-pin";
import {
	CLAUDE_CODE_POLL_SCRIPT,
	type ClaudeCodeFeed,
	type ClaudeCodeStepInput,
	type ClaudeCodeStore,
	claudeCodeCommandId,
	claudeCodeLaunchCommand,
	runClaudeCodeStep,
	stopClaudeCodeRun,
} from "./claude-code-runner";
import { CLAUDE_STEP_PAUSE_MS } from "./claude-step-pause";

it.skipIf(process.platform !== "linux")(
	"the real poll script checks scoped PID/start ownership, tolerates launch races and detects a reboot-lost record",
	() => {
		const results = execFileSync(
			"python3",
			[
				"-c",
				`import json,os,pathlib,shutil,subprocess,sys,tempfile,time,uuid
turn=str(uuid.uuid4()); root=pathlib.Path(tempfile.mkdtemp()); d=root/turn/'1'; d.mkdir(parents=True)
scope=pathlib.Path('/tmp/ytimesy-api-command-scopes')/turn; scope.mkdir(parents=True)
record=scope/('cc-'+turn+'-1.json'); started=d/'started'; started.touch()
p=subprocess.Popen(['python3','-c','import time; time.sleep(60)'],start_new_session=True)
def poll(): return json.loads(subprocess.check_output(['python3','-c',sys.argv[1],str(d),'-1','1024'],text=True).splitlines()[0])
try:
    tick=pathlib.Path('/proc/'+str(p.pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    fresh=poll()['process']
    os.utime(started,(time.time()-60,time.time()-60))
    record.write_text(json.dumps({'pid':p.pid,'start':tick}))
    live=poll()['process']
    record.write_text(json.dumps({'pid':p.pid,'start':'wrong-start-tick'}))
    reused=poll()['process']
    record.unlink(); lost=poll()['process']
    (d/'status').write_text('0'); completed=poll()['process']
    print(json.dumps([fresh,live,reused,lost,completed]))
finally:
    p.terminate(); p.wait(); shutil.rmtree(root); shutil.rmtree(scope)
`,
				CLAUDE_CODE_POLL_SCRIPT,
			],
			{ encoding: "utf8" },
		);
		expect(JSON.parse(results)).toEqual([
			null,
			"alive",
			"missing",
			"missing",
			null,
		]);
	},
);

const hasPython = (() => {
	try {
		execFileSync("python3", ["-c", "pass"]);
		return true;
	} catch {
		return false;
	}
})();

it.skipIf(!hasPython)(
	"the real poll script saves an offset only forward",
	() => {
		const directory = mkdtempSync(join(tmpdir(), "claude-poll-"));
		try {
			writeFileSync(
				join(directory, "out"),
				`${"a".repeat(99)}\n${"b".repeat(99)}\n`,
			);
			writeFileSync(join(directory, "offset"), "100");
			const poll = (commit: number) =>
				JSON.parse(
					execFileSync(
						"python3",
						["-c", CLAUDE_CODE_POLL_SCRIPT, directory, String(commit), "1024"],
						{ encoding: "utf8" },
					).split("\n")[0] ?? "",
				) as { offset: number; next: number };
			const offset = () => readFileSync(join(directory, "offset"), "utf8");
			// An older position (a feed step's) leaves the saved one.
			expect(poll(0)).toMatchObject({ offset: 100, next: 200 });
			expect(offset()).toBe("100");
			expect(poll(-1)).toMatchObject({ offset: 100 });
			expect(offset()).toBe("100");
			// A further one is saved.
			expect(poll(200)).toMatchObject({ offset: 200, next: 200 });
			expect(offset()).toBe("200");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

const HOME = "/home/ubuntu";
const CWD = "/home/ubuntu/repo";
const TURN = "22222222-2222-4222-8222-222222222222";
const SESSION = "11111111-1111-4111-8111-111111111111";
const CLAUDE_SESSION = "33333333-3333-4333-8333-333333333333";
const SECRET = "g".repeat(40);
const RUNS = `${HOME}/.ytimesy/claude-runs/${TURN}`;

/** A VM that understands just the commands the runner sends. */
class FakeVm {
	readonly files = new Map<string, string>();
	readonly launched: string[] = [];
	readonly installs: string[] = [];
	out = "";
	status: string | null = null;
	stderr = "";
	commandCount = 0;

	shell = vi.fn(async (command: string) => {
		const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
		if (command.includes('/current" 2>/dev/null')) {
			const run = this.files.get(`${RUNS}/current`) ?? "";
			if (!run) return ok(`${HOME}\n\n`);
			const consumed = this.files.has(`${RUNS}/${run}/consumed`);
			return ok(
				`${HOME}\n${run}\n${consumed ? "consumed" : "active"}\n${this.files.get(`${RUNS}/session`) ?? ""}`,
			);
		}
		if (
			command.includes(CLAUDE_AGENT_SDK_MODULE) &&
			command.includes("--version")
		) {
			this.installs.push(command);
			return ok();
		}
		this.commandCount++;
		for (const write of command.matchAll(
			/printf %s '([^']*)' \| base64 -d (>>?) '([^']+)'/g,
		)) {
			const [, data = "", mode, path = ""] = write;
			const text = Buffer.from(data, "base64").toString("utf8");
			this.files.set(
				path,
				mode === ">>" ? (this.files.get(path) ?? "") + text : text,
			);
		}
		if (!command.includes("setsid nohup") && command.includes("base64 -d"))
			return ok();
		if (command.includes("setsid nohup")) {
			const decoded = (
				command
					.slice(command.indexOf("setsid nohup"))
					.match(/[A-Za-z0-9+/=]{60,}/g) ?? []
			)
				.map((token) => Buffer.from(token, "base64").toString("utf8"))
				.find((text) => text.includes("exec ") || text.includes("sudo -n -u"));
			this.launched.push(decoded ?? command);
			const run = /d='([^']+)'/.exec(command)?.[1] ?? "";
			this.files.set(`${run}/started`, "1");
			this.files.set(`${RUNS}/current`, run.slice(run.lastIndexOf("/") + 1));
			return ok();
		}
		const poll = /'([^']+)' (-?\d+) (\d+)$/.exec(command);
		if (command.startsWith("python3 -c") && poll) {
			const [, dir = "", commit = "-1", limit = "0"] = poll;
			// As the real script: the saved offset only moves forward.
			const saved = Number(this.files.get(`${dir}/offset`) ?? "0");
			if (Number(commit) > saved) this.files.set(`${dir}/offset`, commit);
			const offset = Math.max(saved, Number(commit));
			const bytes = Buffer.from(this.out, "utf8");
			const data = bytes.subarray(offset, offset + Number(limit));
			const end = data.lastIndexOf(10);
			const lines: string[] = [];
			let next = offset;
			if (end >= 0) {
				let position = offset;
				for (const raw of data
					.subarray(0, end + 1)
					.toString()
					.split("\n")
					.slice(0, -1)) {
					lines.push(`${position}\t${raw}`);
					position += Buffer.byteLength(raw) + 1;
				}
				next = offset + end + 1;
			}
			return ok(
				[
					JSON.stringify({
						offset,
						next,
						status: this.status,
						size: bytes.length,
					}),
					...lines,
				].join("\n"),
			);
		}
		if (command.startsWith("stat -c %s ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return ok(String(Buffer.byteLength(this.files.get(path) ?? "")));
		}
		if (command.startsWith("test -s ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return { exitCode: this.files.get(path) ? 0 : 1, stdout: "", stderr: "" };
		}
		if (command.includes("/consumed")) {
			const dir = /: > '([^']+)\/consumed'/.exec(command)?.[1] ?? "";
			const commit = /printf '%s' (\d+) > /.exec(command)?.[1];
			if (commit) this.files.set(`${dir}/offset`, commit);
			this.files.set(`${dir}/consumed`, "");
			return ok();
		}
		const session = /printf '%s' '([^']+)' > '([^']+)'$/.exec(command);
		if (session) {
			this.files.set(session[2] ?? "", session[1] ?? "");
			return ok();
		}
		if (command.startsWith("tail -c 2000")) return ok(this.stderr);
		if (command.startsWith("cat -- ")) {
			const path = /'([^']+)'/.exec(command)?.[1] ?? "";
			return ok(this.files.get(path) ?? "");
		}
		return ok();
	});

	emit(...events: unknown[]) {
		this.out += events.map((event) => `${JSON.stringify(event)}\n`).join("");
	}
}

function store(overrides: Partial<ClaudeCodeStore> = {}): ClaudeCodeStore {
	return {
		readSession: vi.fn(async () => null),
		saveSession: vi.fn(async () => {}),
		uploadTranscript: vi.fn(
			async (id: string) => `prefix/claude-code-${id}.enc`,
		),
		downloadTranscript: vi.fn(async () => '{"type":"user"}\n'),
		subscriptionStatus: vi.fn(async () => ({
			status: "connected" as const,
			message: null,
			limitedUntil: null,
			connectedAt: 0,
		})),
		...overrides,
	};
}

function input(
	vm: FakeVm,
	overrides: Partial<ClaudeCodeStepInput> = {},
): ClaudeCodeStepInput & { events: ApiAgentEvent[] } {
	const events: ApiAgentEvent[] = [];
	const seen = new Set<string>();
	const names = new Map<string, string>();
	let clock = 1_000_000;
	return {
		events,
		shell: vm.shell,
		writeFile: async (path, contents) => {
			vm.files.set(path, contents);
		},
		readFile: async (path) => vm.files.get(path) ?? null,
		cwd: CWD,
		userId: "u1",
		sessionId: SESSION,
		turnId: TURN,
		modelId: "claude-opus-5-5",
		messages: [{ role: "user", content: "Fix the failing test." }],
		edgeOrigin: "https://edge.example",
		grantSecret: SECRET,
		reader: false,
		deadline: clock + 600_000,
		signal: new AbortController().signal,
		redact: () => ["hunter2-secret-value"],
		addRedaction: vi.fn(),
		hasItem: (id) => seen.has(id),
		toolName: (id) => names.get(id),
		onEvent: async (event) => {
			events.push(event);
			if ("id" in event) seen.add(event.id);
			if (event.type === "tool-call") names.set(event.id, event.name);
		},
		onPlan: vi.fn(),
		bridge: { pump: vi.fn(), busy: () => false, wait: async () => {} },
		store: store(),
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
		...overrides,
	};
}

const init = {
	type: "system",
	subtype: "init",
	session_id: CLAUDE_SESSION,
	mcp_servers: [{ name: "ytimesy", status: "connected" }],
};
const work = [
	{
		type: "assistant",
		message: {
			id: "msg_1",
			content: [
				{ type: "text", text: "Running the tests with hunter2-secret-value." },
				{
					type: "tool_use",
					id: "toolu_1",
					name: "Bash",
					input: { command: "npm test" },
				},
			],
		},
	},
	{
		type: "user",
		message: {
			content: [
				{ type: "tool_result", tool_use_id: "toolu_1", content: "1 failed" },
			],
		},
	},
	{
		type: "assistant",
		message: {
			id: "msg_2",
			content: [
				{
					type: "tool_use",
					id: "toolu_2",
					name: "TodoWrite",
					input: { todos: [{ content: "Fix it", status: "in_progress" }] },
				},
			],
		},
	},
];
const success = {
	type: "result",
	subtype: "success",
	is_error: false,
	result: "Fixed the test.",
	session_id: CLAUDE_SESSION,
	usage: { input_tokens: 10, output_tokens: 20 },
};

describe("Claude Code runner", () => {
	it("serializes concurrent guest launches and repairs a missing current pointer without launching twice", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude launch "));
		const run = join(directory, "1");
		mkdirSync(run);
		const counter = join(directory, "launches");
		const command = claudeCodeLaunchCommand(
			run,
			directory,
			1,
			`{ printf x >> '${counter}'; }`,
		);
		try {
			await Promise.all([
				promisify(execFile)("bash", ["-c", command]),
				promisify(execFile)("bash", ["-c", command]),
			]);
			await vi.waitFor(() =>
				expect(readFileSync(join(run, "status"), "utf8").trim()).toBe("0"),
			);
			expect(readFileSync(counter, "utf8")).toBe("x");
			unlinkSync(join(directory, "current"));
			await promisify(execFile)("bash", ["-c", command]);
			expect(readFileSync(join(directory, "current"), "utf8")).toBe("1");
			expect(readFileSync(counter, "utf8")).toBe("x");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("the actual SDK wrapper journals its initialized session before streaming it", () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-wrapper-"));
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`export async function* query() { yield { type: "system", subtype: "init", session_id: "${CLAUDE_SESSION}" }; yield { type: "result" }; }`,
			);
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({ model: "local-test", disallowedTools: [] }),
			);
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({ mcpServers: {} }),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			const output = execFileSync(
				process.execPath,
				[
					join(directory, "runner.mjs"),
					join(directory, "sdk.mjs"),
					directory,
					directory,
				],
				{ encoding: "utf8" },
			);
			expect(readFileSync(join(directory, "active-session"), "utf8")).toBe(
				CLAUDE_SESSION,
			);
			expect(
				output
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line).type),
			).toEqual(["system", "result"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("the actual SDK wrapper's hooks hand the model messages the user sent meanwhile", async () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-wrapper-"));
		const { createServer } = await import("node:http");
		const asked: { method: string; authorization?: string }[] = [];
		let answers = ["", "Use pnpm.", "Also add a test."];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				asked.push({
					method: JSON.parse(body).method,
					authorization: request.headers.authorization,
				});
				const [text = "", ...rest] = answers;
				answers = rest;
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text } }),
				);
			});
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const port = (server.address() as { port: number }).port;
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			// The fake SDK fires the hooks as Claude Code would: after two tool
			// calls, then as the run would end.
			writeFileSync(
				join(directory, "sdk.mjs"),
				`export async function* query({ options }) {
					const post = options.hooks.PostToolUse[0].hooks[0];
					const stop = options.hooks.Stop[0].hooks[0];
					yield { type: "hook", output: await post({}) };
					yield { type: "hook", output: await post({}) };
					yield { type: "hook", output: await stop({}) };
					yield { type: "result" };
				}`,
			);
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({ model: "local-test", disallowedTools: [] }),
			);
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						ytimesy: {
							type: "http",
							url: `http://127.0.0.1:${port}/claude-code/mcp`,
							headers: { Authorization: "Bearer grant" },
						},
					},
				}),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			const { stdout } = await promisify(execFile)(process.execPath, [
				join(directory, "runner.mjs"),
				join(directory, "sdk.mjs"),
				directory,
				directory,
			]);
			const hooks = stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.filter((message) => message.type === "hook")
				.map((message) => message.output);
			expect(hooks).toEqual([
				// Nothing sent: the tool's result goes on alone.
				{},
				{
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: "Use pnpm.",
					},
				},
				// Sent as the run would end: it goes on with the message.
				{ decision: "block", reason: "Also add a test." },
			]);
			expect(asked).toEqual(
				Array(3).fill({
					method: "ytimesy/inbox",
					authorization: "Bearer grant",
				}),
			);
		} finally {
			server.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("runs the CLI with a grant, never the token, and maps its stream", async () => {
		const vm = new FakeVm();
		vm.emit(init, ...work, success);
		vm.status = "0";
		vm.files.set(
			`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			'{"type":"user"}\n',
		);
		const step = input(vm);
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("completed");
		expect(result.messages.at(-1)).toEqual({
			role: "assistant",
			content: "Fixed the test.",
		});
		expect(vm.installs).toHaveLength(1);
		// The VM gets a signed grant for this turn and the edge as its base URL.
		const env = vm.files.get(`${RUNS}/1/env`) ?? "";
		const grant = /CLAUDE_CODE_OAUTH_TOKEN='([^']+)'/.exec(env)?.[1];
		expect(await verifyClaudeCodeGrant(SECRET, grant)).toMatchObject({
			userId: "u1",
			sessionId: SESSION,
			turnId: TURN,
		});
		expect(env).toContain(
			"ANTHROPIC_BASE_URL='https://edge.example/claude-code'",
		);
		expect(step.addRedaction).toHaveBeenCalledWith(grant);
		expect(env).toContain("DISABLE_AUTOUPDATER='1'");
		expect(env).not.toMatch(/sk-ant/);
		const mcp = JSON.parse(vm.files.get(`${RUNS}/1/mcp.json`) ?? "{}");
		expect(mcp.mcpServers.ytimesy).toEqual({
			type: "http",
			url: "https://edge.example/claude-code/mcp",
			headers: { Authorization: `Bearer ${grant}` },
		});
		expect(vm.files.get(`${RUNS}/1/prompt`)).toBe("Fix the failing test.");
		// The Agent SDK runs it: our runner script, the pinned SDK, its options.
		const launched = vm.launched[0] ?? "";
		expect(launched).toContain(
			`'/usr/local/bin/node' '${RUNS}/1/runner.mjs' '${CLAUDE_AGENT_SDK_MODULE}' '${RUNS}/1' '${CWD}'`,
		);
		expect(launched).toContain("unset ANTHROPIC_API_KEY");
		expect(vm.files.get(`${RUNS}/1/runner.mjs`)).toBe(
			CLAUDE_AGENT_RUNNER_SCRIPT,
		);
		expect(JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "")).toEqual({
			model: "claude-opus-5-5",
			effort: null,
			disallowedTools: expect.arrayContaining([
				"Bash",
				"Task",
				"TaskOutput",
				"TaskStop",
				"AskUserQuestion",
			]),
			resume: null,
		});
		expect(vm.files.get(`${RUNS}/1/system`)).toContain(
			"including background commands",
		);
		expect(vm.files.get(`${RUNS}/1/system`)).toContain(
			"mcp__ytimesy__run_code",
		);
		expect(vm.files.get(`${RUNS}/1/system`)).toContain(
			"Do not bypass tracking",
		);
		// The run asks for summarized reasoning; by default the API omits its text.
		expect(CLAUDE_AGENT_RUNNER_SCRIPT).toContain(
			'thinking: { type: "adaptive", display: "summarized" }',
		);
		// The workspace commands (browser, jobs) it could never discover by itself.
		expect(vm.files.get(`${RUNS}/1/system`)).toContain("ytimesy-browser");
		expect(vm.files.get(`${RUNS}/1/system`)).toContain("ytimesy-job wait");
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").disallowedTools,
		).not.toContain("TodoWrite");
		// The timeline: redacted text, the tool call and result, usage, finish.
		expect(step.events.map((event) => event.type)).toEqual([
			"text-delta",
			"tool-call",
			"tool-result",
			"usage",
			"finish",
		]);
		expect(JSON.stringify(step.events)).not.toContain("hunter2-secret-value");
		expect(step.onPlan).toHaveBeenCalledWith([
			{ step: "Fix it", status: "in_progress" },
		]);
		// The session is saved for the next machine.
		expect(step.store.uploadTranscript).toHaveBeenCalledWith(
			CLAUDE_SESSION,
			'{"type":"user"}\n',
		);
		expect(step.store.saveSession).toHaveBeenCalledWith({
			claudeSessionId: CLAUDE_SESSION,
			transcriptPath: `prefix/claude-code-${CLAUDE_SESSION}.enc`,
			cwd: CWD,
		});
		expect(vm.files.get(`${RUNS}/session`)).toBe(CLAUDE_SESSION);
		expect(vm.files.has(`${RUNS}/1/consumed`)).toBe(true);
	});

	it("yields at its deadline and the next step re-attaches to the same run", async () => {
		const vm = new FakeVm();
		vm.emit(init, work[0]);
		const first = input(vm);
		const yielded = await runClaudeCodeStep({
			...first,
			deadline: 1_000_000 + 1_000,
		});
		expect(yielded.outcome).toBe("continue");
		expect(vm.launched).toHaveLength(1);
		expect(first.events.map((event) => event.type)).toEqual([
			"text-delta",
			"tool-call",
		]);
		vm.emit(work[1], success);
		vm.status = "0";
		// The chat's items carry over: the result finds its call.
		const second = input(vm, { toolName: first.toolName });
		const finished = await runClaudeCodeStep(second);
		expect(finished.outcome).toBe("completed");
		expect(vm.launched).toHaveLength(1);
		expect(second.events.map((event) => event.type)).toEqual([
			"tool-result",
			"usage",
			"finish",
		]);
	});

	it("does not yield while a ytimesy tool call is still answering", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		let busy = true;
		const step = input(vm, {
			deadline: 1_000_000,
			bridge: {
				pump: vi.fn(),
				busy: () => busy,
				wait: async () => {},
			},
		});
		let polls = 0;
		const sleep = async () => {
			polls += 1;
			if (polls === 3) busy = false;
		};
		const result = await runClaudeCodeStep({ ...step, sleep });
		expect(result.outcome).toBe("continue");
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(step.bridge.pump).toHaveBeenCalled();
	});

	it("restores the chat's saved session on a new machine and resumes it", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const saved = store({
			readSession: vi.fn(async () => ({
				claudeSessionId: CLAUDE_SESSION,
				transcriptPath: "prefix/claude-code-x.enc",
				cwd: CWD,
			})),
		});
		const step = input(vm, {
			store: saved,
			messages: [
				{ role: "user", content: "First." },
				{ role: "assistant", content: "Done first." },
				{ role: "user", content: "Second." },
			],
		});
		await runClaudeCodeStep(step);
		expect(saved.downloadTranscript).toHaveBeenCalledWith(
			"prefix/claude-code-x.enc",
		);
		expect(
			vm.files.get(
				`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			),
		).toBe('{"type":"user"}\n');
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").resume,
		).toBe(CLAUDE_SESSION);
		expect(vm.files.get(`${RUNS}/1/prompt`)).toBe("Second.");
	});

	it("starts fresh with the conversation when no session can be restored", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const step = input(vm, {
			messages: [
				{ role: "user", content: "First." },
				{ role: "assistant", content: "Done first." },
				{ role: "user", content: "Second." },
			],
		});
		await runClaudeCodeStep(step);
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").resume,
		).toBeNull();
		expect(vm.files.get(`${RUNS}/1/prompt`)).toContain("User: First.");
	});

	it("reports a spent plan so the turn can fail over", async () => {
		const vm = new FakeVm();
		vm.emit(init, {
			type: "result",
			subtype: "success",
			is_error: true,
			result: "Claude AI usage limit reached|1900000000",
		});
		vm.status = "1";
		const step = input(vm, {
			store: store({
				subscriptionStatus: vi.fn(async () => ({
					status: "limited" as const,
					message: null,
					limitedUntil: 1_900_000_000_000,
					connectedAt: 0,
				})),
			}),
		});
		const failure = await runClaudeCodeStep(step).catch((error) => error);
		expect(failure).toBeInstanceOf(ClaudeSubscriptionLimitReached);
		expect(
			(failure as ClaudeSubscriptionLimitReached).resetsAt?.getTime(),
		).toBe(1_900_000_000_000);
	});

	it("reports a refused token when the CLI exits without an answer", async () => {
		const vm = new FakeVm();
		vm.status = "1";
		vm.stderr = "API Error: 401 OAuth token has expired";
		const failure = await runClaudeCodeStep(input(vm)).catch((error) => error);
		expect(failure).toBeInstanceOf(ClaudeSubscriptionRefused);
	});

	it("never shows Claude Code's own API error as the reply; a refused token fails the step", async () => {
		const vm = new FakeVm();
		const refused =
			'Failed to authenticate. API Error: 403 {"type":"error","error":{"type":"permission_error","message":"This turn\'s access ended."}}';
		vm.emit(
			init,
			{
				type: "assistant",
				error: "authentication_failed",
				message: {
					model: "<synthetic>",
					content: [{ type: "text", text: refused }],
				},
			},
			{
				type: "result",
				subtype: "success",
				is_error: true,
				result: refused,
				session_id: CLAUDE_SESSION,
			},
		);
		vm.status = "1";
		const step = input(vm);
		const failure = await runClaudeCodeStep(step).catch((error) => error);
		expect(failure).toBeInstanceOf(ClaudeSubscriptionRefused);
		expect(step.events.some((event) => event.type === "text-delta")).toBe(
			false,
		);
	});

	it("fails over when Claude Code reports Anthropic overloaded", async () => {
		const vm = new FakeVm();
		vm.emit(
			init,
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "API Error: 529 Overloaded" }],
				},
			},
			{ type: "result", subtype: "success", is_error: true, result: "" },
		);
		vm.status = "1";
		const step = input(vm);
		const failure = await runClaudeCodeStep(step).catch((error) => error);
		expect(failure).toBeInstanceOf(ClaudeCodeApiUnavailable);
		expect((failure as ClaudeCodeApiUnavailable).reason).toBe("overloaded");
		expect(step.events.some((event) => event.type === "text-delta")).toBe(
			false,
		);
	});

	it("starts a fresh run in three round trips: state, SDK check, then inputs with the launch", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		await runClaudeCodeStep(input(vm));
		const commands = vm.shell.mock.calls.map(([command]) => String(command));
		const firstPoll = commands.findIndex((command) =>
			command.startsWith("python3 -c"),
		);
		expect(firstPoll).toBe(3);
		expect(commands[2]).toContain("setsid nohup");
		for (const name of ["env", "mcp.json", "system", "prompt", "options.json"])
			expect(vm.files.has(`${RUNS}/1/${name}`)).toBe(true);
	});

	it("continues the step without launching Claude while the SDK download is pending", async () => {
		const vm = new FakeVm();
		const original = vm.shell.getMockImplementation();
		vm.shell.mockImplementation(async (command: string) => {
			if (
				command.includes(CLAUDE_AGENT_SDK_MODULE) &&
				command.includes("--version")
			)
				return { exitCode: 78, stdout: "", stderr: "" };
			if (command.includes("run.sh"))
				return {
					exitCode: 0,
					stdout: String(Math.floor(Date.now() / 1000)),
					stderr: "",
				};
			if (command.startsWith("cat '/tmp/ytimesy-detached/"))
				return { exitCode: 0, stdout: "", stderr: "" };
			return original?.(command) as never;
		});
		expect(
			await runClaudeCodeStep(input(vm, { deadline: Date.now() })),
		).toMatchObject({ outcome: "continue" });
		expect(vm.launched).toEqual([]);
		expect(vm.files.has(`${RUNS}/1/prompt`)).toBe(false);
	});

	it("reports the context size and window when the run finishes, for the composer's ring", async () => {
		const vm = new FakeVm();
		vm.emit(
			init,
			{
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Hello." }],
					usage: {
						input_tokens: 4,
						cache_creation_input_tokens: 3784,
						cache_read_input_tokens: 17250,
						output_tokens: 8,
					},
				},
			},
			{
				...success,
				modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } },
			},
		);
		vm.status = "0";
		const step = input(vm);
		await runClaudeCodeStep(step);
		const context = step.events.find((event) => event.type === "context");
		expect(context).toEqual({
			type: "context",
			compacting: false,
			context: {
				last: { totalTokens: 21046 },
				modelContextWindow: 1_000_000,
			},
		});
		// The ring reads this after the usage record and before the run is marked finished.
		const order = step.events.map((event) => event.type);
		expect(order.indexOf("context")).toBeGreaterThan(order.indexOf("usage"));
		expect(order.indexOf("context")).toBeLessThan(order.indexOf("finish"));
	});

	it("shows no ring reading when the result names no context window", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const step = input(vm);
		await runClaudeCodeStep(step);
		expect(step.events.some((event) => event.type === "context")).toBe(false);
	});

	it("hands the effort chosen in the picker to the run, and none when none was chosen", async () => {
		const chosen = new FakeVm();
		chosen.emit(init, success);
		chosen.status = "0";
		await runClaudeCodeStep(input(chosen, { effort: "xhigh" }));
		expect(
			JSON.parse(chosen.files.get(`${RUNS}/1/options.json`) ?? "").effort,
		).toBe("xhigh");
		const unchosen = new FakeVm();
		unchosen.emit(init, success);
		unchosen.status = "0";
		await runClaudeCodeStep(input(unchosen));
		expect(
			JSON.parse(unchosen.files.get(`${RUNS}/1/options.json`) ?? "").effort,
		).toBeNull();
		// The run program passes it on to the SDK only when there is one.
		expect(CLAUDE_AGENT_RUNNER_SCRIPT).toContain(
			"if (settings.effort) options.effort = settings.effort;",
		);
	});

	it("on a runner box turns Claude's own file and shell tools off and says where the code is", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		await runClaudeCodeStep(
			input(vm, {
				remote: {
					repository: "/home/ubuntu/app",
					workspaceTools: ["read", "bash"],
				},
			}),
		);
		const options = JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "");
		expect(options.disallowedTools).toEqual(
			expect.arrayContaining([
				"Bash",
				"Read",
				"Edit",
				"Write",
				"Glob",
				"Grep",
				"Workflow",
				"CronCreate",
			]),
		);
		expect(options.disallowedTools).not.toContain("TodoWrite");
		const system = vm.files.get(`${RUNS}/1/system`) ?? "";
		expect(system).toContain("/home/ubuntu/app");
		expect(system).toContain("mcp__ytimesy__read, mcp__ytimesy__bash");
		expect(system).toContain("mcp__ytimesy__run_code");
		expect(system).toContain("mcp__ytimesy__update_plan");
		expect(system).not.toContain("on this chat's own cloud machine");
	});

	it("on a runner box saves the session while the run goes, once a minute", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		vm.files.set(
			`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			"transcript so far",
		);
		const step = input(vm, {
			remote: { repository: "/home/ubuntu/app", workspaceTools: [] },
		});
		const result = await runClaudeCodeStep({
			...step,
			deadline: 1_000_000 + 400_000,
		});
		expect(result.outcome).toBe("continue");
		expect(step.store.uploadTranscript).toHaveBeenCalledWith(
			CLAUDE_SESSION,
			"transcript so far",
		);
		// Not on every poll: a few uploads across several minutes, not dozens.
		expect(
			vi.mocked(step.store.uploadTranscript).mock.calls.length,
		).toBeLessThan(10);
	});

	it("keeps polling and answering tool calls while a slow transcript backup uploads", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		vm.files.set(
			`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			"transcript so far",
		);
		const step = input(vm, {
			remote: { repository: "/home/ubuntu/app", workspaceTools: [] },
		});
		let release: () => void = () => {};
		let uploading = false;
		let pumpsWhileUploading = 0;
		vi.mocked(step.store.uploadTranscript).mockImplementation(async () => {
			uploading = true;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			uploading = false;
			return "path";
		});
		const pump = vi.fn(() => {
			// Each upload is let go after five more polls.
			if (uploading && ++pumpsWhileUploading % 5 === 0) release();
		});
		const result = await runClaudeCodeStep({
			...step,
			bridge: { ...step.bridge, pump },
			deadline: 1_000_000 + 400_000,
		});
		expect(result.outcome).toBe("continue");
		// The loop went on (and would hand tool calls over) during the upload.
		expect(pumpsWhileUploading).toBeGreaterThanOrEqual(5);
		// The step never returns with the upload still running.
		expect(uploading).toBe(false);
	});

	it("a deploy cutting a poll interrupts the step (it resumes), never fails the run", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		const step = input(vm);
		let polls = 0;
		const shell: typeof step.shell = async (command) => {
			if (command.includes("python3 -c") && ++polls === 2)
				throw new Error("Durable Object reset because its code was updated.");
			return vm.shell(command);
		};
		await expect(runClaudeCodeStep({ ...step, shell })).rejects.toThrow(
			"its code was updated",
		);
	});

	it("polls that fail near the step's end yield the step instead of failing the run", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		const original = vm.shell.getMockImplementation();
		let polls = 0;
		vm.shell.mockImplementation(async (command: string) => {
			if (command.startsWith("python3 -c") && ++polls > 1)
				throw new Error("The operation was aborted due to timeout");
			return original?.(command) as never;
		});
		const result = await runClaudeCodeStep(
			input(vm, { deadline: 1_000_000 + 20_000 }),
		);
		// Before: "Claude Agent stopped: its output could not be read."
		expect(result.outcome).toBe("continue");
	});

	it("a quiet, unwatched step ends early and asks the chat's object to sleep", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		const requestPause = vi.fn();
		const result = await runClaudeCodeStep(
			input(vm, { mayPause: () => true, requestPause }),
		);
		expect(result.outcome).toBe("continue");
		expect(requestPause).toHaveBeenCalledWith(15_000);
	});

	it("never pauses with a tool call in flight or someone watching", async () => {
		for (const overrides of [
			{
				mayPause: () => true,
				bridge: { pump: vi.fn(), busy: () => true, wait: async () => {} },
			},
			{ mayPause: () => false },
		]) {
			const vm = new FakeVm();
			vm.emit(init);
			const requestPause = vi.fn();
			const step = input(vm, { ...overrides, requestPause });
			await runClaudeCodeStep({ ...step, deadline: 1_000_000 + 30_000 });
			expect(requestPause).not.toHaveBeenCalled();
		}
	});

	it("asks before launching a run, and refuses the run when told to", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const beforeLaunch = vi.fn(async () => {});
		await runClaudeCodeStep(input(vm, { beforeLaunch }));
		expect(beforeLaunch).toHaveBeenCalledTimes(1);

		const refused = new FakeVm();
		await expect(
			runClaudeCodeStep(
				input(refused, {
					beforeLaunch: async () => {
						throw new ClaudeCodeRunFailure(
							"its runner is full, so it did not start.",
						);
					},
				}),
			),
		).rejects.toThrow("its runner is full");
		expect(refused.launched).toEqual([]);
	});

	it("on the chat's own machine saves the session only when the run ends", async () => {
		const vm = new FakeVm();
		vm.emit(init);
		const step = input(vm);
		await runClaudeCodeStep({ ...step, deadline: 1_000_000 + 400_000 });
		expect(step.store.uploadTranscript).not.toHaveBeenCalled();
	});

	it("reads again after a poll the machine did not answer, and fails only when it stays silent", async () => {
		const flaky = (silent: number) => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			const original = vm.shell.getMockImplementation();
			let missed = 0;
			vm.shell.mockImplementation(async (command: string) =>
				command.startsWith("python3 -c") && missed++ < silent
					? { exitCode: 124, stdout: "", stderr: "" }
					: (original?.(command) as never),
			);
			return vm;
		};
		await expect(runClaudeCodeStep(input(flaky(3)))).resolves.toMatchObject({
			outcome: "completed",
		});
		await expect(runClaudeCodeStep(input(flaky(9)))).rejects.toThrow(
			"its output could not be read",
		);
	});

	it("retries a transient transport poll without replaying launch, and bounds a runner outage", async () => {
		for (const missed of [2, 9]) {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			const original = vm.shell.getMockImplementation();
			let polls = 0;
			vm.shell.mockImplementation(async (command) => {
				if (command.startsWith("python3 -c") && ++polls <= missed)
					throw new ClaudeRunnerTransportFailure("exec", "http", 502);
				return original?.(command) as never;
			});
			const result = runClaudeCodeStep(input(vm));
			if (missed === 2)
				await expect(result).resolves.toMatchObject({ outcome: "completed" });
			else
				await expect(result).rejects.toMatchObject({
					name: "ClaudeRunnerTransportFailure",
					operation: "poll",
					httpStatus: 502,
				});
			expect(polls).toBe(missed === 2 ? 3 : 5);
			expect(vm.launched).toHaveLength(1);
		}
	});

	it("continues remote state/read outages and reattaches after recovery without replaying launch", async () => {
		for (const phase of ["state", "poll"]) {
			const vm = new FakeVm();
			const original = vm.shell.getMockImplementation();
			let down = true;
			let failedReads = 0;
			vm.shell.mockImplementation(async (command) => {
				const observation =
					phase === "state"
						? command.includes('n=$(cat "$d/current"')
						: command.startsWith("python3 -c");
				if (down && observation) {
					failedReads++;
					throw new ClaudeRunnerTransportFailure("exec", "http", 530);
				}
				return original?.(command) as never;
			});
			const remote = { repository: CWD, workspaceTools: [] };
			await expect(
				runClaudeCodeStep(input(vm, { remote })),
			).resolves.toMatchObject({ outcome: "continue" });
			expect(failedReads).toBe(5);
			expect(vm.launched).toHaveLength(phase === "state" ? 0 : 1);
			down = false;
			vm.emit(init, success);
			vm.status = "0";
			await expect(
				runClaudeCodeStep(input(vm, { remote })),
			).resolves.toMatchObject({ outcome: "completed" });
			expect(vm.launched).toHaveLength(1);
		}
	});

	it("does not turn an aborted remote observation into continuation", async () => {
		const vm = new FakeVm();
		const controller = new AbortController();
		vm.shell.mockImplementation(async () => {
			controller.abort(new Error("user stopped"));
			throw new ClaudeRunnerTransportFailure("exec", "network");
		});
		await expect(
			runClaudeCodeStep(
				input(vm, {
					remote: { repository: CWD, workspaceTools: [] },
					signal: controller.signal,
				}),
			),
		).rejects.toThrow("user stopped");
		expect(vm.launched).toHaveLength(0);
	});

	it("reports a lost process after two observations without relaunching or consuming its output", async () => {
		const vm = new FakeVm();
		const original = vm.shell.getMockImplementation();
		let polls = 0;
		vm.shell.mockImplementation(async (command) => {
			if (command.startsWith("python3 -c")) {
				polls++;
				return {
					exitCode: 0,
					stdout: JSON.stringify({
						offset: 0,
						next: 0,
						size: 0,
						status: null,
						process: "missing",
					}),
					stderr: "",
				};
			}
			return original?.(command) as never;
		});
		await expect(runClaudeCodeStep(input(vm))).rejects.toMatchObject({
			name: "ClaudeCodeRunInterrupted",
		});
		expect(polls).toBe(2);
		expect(vm.launched).toHaveLength(1);
		expect(vm.files.has(`${RUNS}/1/consumed`)).toBe(false);
	});

	it("does not wait through a runner outage past this step's budget", async () => {
		const vm = new FakeVm();
		const original = vm.shell.getMockImplementation();
		let polls = 0;
		vm.shell.mockImplementation(async (command) => {
			if (command.startsWith("python3 -c")) {
				polls++;
				throw new ClaudeRunnerTransportFailure("exec", "timeout");
			}
			return original?.(command) as never;
		});
		const sleep = vi.fn(async () => {});
		await expect(
			runClaudeCodeStep(input(vm, { deadline: 1_002_000, sleep })),
		).rejects.toMatchObject({ operation: "poll", reason: "timeout" });
		expect(polls).toBe(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("does not retry an unauthorized observation or a lost launch reply", async () => {
		for (const launch of [false, true]) {
			const vm = new FakeVm();
			const original = vm.shell.getMockImplementation();
			let failedCalls = 0;
			vm.shell.mockImplementation(async (command) => {
				if (
					launch
						? command.includes("setsid nohup")
						: command.startsWith("python3 -c")
				) {
					failedCalls++;
					throw new ClaudeRunnerTransportFailure(
						"exec",
						"http",
						launch ? 502 : 403,
					);
				}
				return original?.(command) as never;
			});
			await expect(runClaudeCodeStep(input(vm))).rejects.toMatchObject({
				operation: launch ? "exec" : "poll",
				httpStatus: launch ? 502 : 403,
			});
			expect(failedCalls).toBe(1);
		}
	});

	it("does not launch when writing an input failed", async () => {
		const vm = new FakeVm();
		const original = vm.shell.getMockImplementation();
		vm.shell.mockImplementation(async (command: string) =>
			command.includes("base64 -d")
				? { exitCode: 1, stdout: "", stderr: "" }
				: (original?.(command) as never),
		);
		await expect(runClaudeCodeStep(input(vm))).rejects.toThrow();
		expect(vm.launched).toEqual([]);
	});

	it("stops the run it launched, alone, once the turn moves to another model", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		await runClaudeCodeStep(input(vm));
		const launch = vm.shell.mock.calls
			.map(([command]) => String(command))
			.find((command) => command.includes("setsid nohup"));
		expect(launch).toContain(claudeCodeCommandId(TURN, 1));
		vm.shell.mockClear();
		await stopClaudeCodeRun(vm.shell, TURN);
		const [stop] = vm.shell.mock.calls.map(([command]) => String(command));
		expect(stop).toContain(`/.ytimesy/claude-runs/${TURN}`);
		expect(stop).toContain(`"cc-${TURN}-$n"`);
		expect(stop).toContain(`/tmp/ytimesy-api-command-scopes/${TURN}`);
		expect(stop).toContain('"$d/$n/consumed"');
		await expect(stopClaudeCodeRun(vm.shell, "../x")).rejects.toThrow();
	});

	it.each([null, "prefix/last-good.enc"])(
		"never transfers a 249 MiB transcript and retains prior checkpoint %s",
		async (previousPath) => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			const original = vm.shell.getMockImplementation();
			vm.shell.mockImplementation(async (command) =>
				command.startsWith("stat -c %s ")
					? { exitCode: 0, stdout: String(249 * 1024 * 1024), stderr: "" }
					: original
						? original(command)
						: { exitCode: 0, stdout: "", stderr: "" },
			);
			const readFile = vi.fn(async () => "must not be loaded");
			const step = input(vm, {
				readFile,
				store: store({
					readSession: vi.fn(async () =>
						previousPath
							? {
									claudeSessionId: CLAUDE_SESSION,
									transcriptPath: previousPath,
									cwd: CWD,
								}
							: null,
					),
				}),
			});
			await expect(runClaudeCodeStep(step)).resolves.toMatchObject({
				outcome: "completed",
			});
			expect(readFile).not.toHaveBeenCalled();
			expect(step.store.uploadTranscript).not.toHaveBeenCalled();
			expect(step.store.saveSession).toHaveBeenCalledWith({
				claudeSessionId: CLAUDE_SESSION,
				transcriptPath: previousPath,
				cwd: CWD,
			});
		},
	);

	it("leaves a 12 MiB transcript on the VM instead of copying it through the Durable Object", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const original = vm.shell.getMockImplementation();
		vm.shell.mockImplementation(async (command) =>
			command.startsWith("stat -c %s ")
				? { exitCode: 0, stdout: String(12 * 1024 * 1024), stderr: "" }
				: original
					? original(command)
					: { exitCode: 0, stdout: "", stderr: "" },
		);
		const readFile = vi.fn(async () => "must not be loaded");
		const step = input(vm, {
			readFile,
			store: store({
				readSession: vi.fn(async () => ({
					claudeSessionId: CLAUDE_SESSION,
					transcriptPath: "prefix/last-good.enc",
					cwd: CWD,
				})),
			}),
		});
		await expect(runClaudeCodeStep(step)).resolves.toMatchObject({
			outcome: "completed",
		});
		expect(readFile).not.toHaveBeenCalled();
		expect(step.store.uploadTranscript).not.toHaveBeenCalled();
		expect(step.store.saveSession).toHaveBeenCalledWith({
			claudeSessionId: CLAUDE_SESSION,
			transcriptPath: "prefix/last-good.enc",
			cwd: CWD,
		});
	});

	describe("direct transcript backup (the VM encrypts and uploads; the Durable Object never holds the file)", () => {
		const direct = (overrides: Partial<DirectTranscriptStore> = {}) => ({
			prepareUpload: vi.fn(async (id: string) => ({
				path: `prefix/claude-code-${id}.direct`,
				config: {
					url: "https://r2.example/put?X-Amz-Signature=sig1",
					dataKey: "DATAKEY",
					path: `prefix/claude-code-${id}.direct`,
					header: "v2.wrapped",
				},
			})),
			prepareDownload: vi.fn(async (path: string) => ({
				config: {
					url: "https://r2.example/get?X-Amz-Signature=sig2",
					dataKey: "DATAKEY",
					path,
				},
			})),
			...overrides,
		});
		const withSize = (vm: FakeVm, bytes: number, nodeExit = 0) => {
			const original = vm.shell.getMockImplementation();
			vm.shell.mockImplementation(async (command) => {
				if (command.startsWith("stat -c %s "))
					return { exitCode: 0, stdout: String(bytes), stderr: "" };
				if (command.startsWith("/usr/local/bin/node -e "))
					return { exitCode: nodeExit, stdout: "", stderr: "" };
				return original
					? original(command)
					: { exitCode: 0, stdout: "", stderr: "" };
			});
		};
		const nodeCommands = (vm: FakeVm) =>
			vm.shell.mock.calls
				.map(([command]) => String(command))
				.filter((command) => command.startsWith("/usr/local/bin/node -e "));

		it("uploads a 12 MiB transcript from the VM, with the key and URL only in a one-use file", async () => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			withSize(vm, 12 * 1024 * 1024);
			const readFile = vi.fn(async () => "must not be loaded");
			const channel = direct();
			const step = input(vm, {
				readFile,
				store: store({ direct: channel }),
			});
			await expect(runClaudeCodeStep(step)).resolves.toMatchObject({
				outcome: "completed",
			});
			expect(channel.prepareUpload).toHaveBeenCalledWith(CLAUDE_SESSION);
			expect(readFile).not.toHaveBeenCalled();
			expect(step.store.uploadTranscript).not.toHaveBeenCalled();
			expect(step.store.saveSession).toHaveBeenCalledWith({
				claudeSessionId: CLAUDE_SESSION,
				transcriptPath: `prefix/claude-code-${CLAUDE_SESSION}.direct`,
				cwd: CWD,
			});
			const [upload] = nodeCommands(vm);
			expect(upload).toContain(
				`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			);
			// Neither the signed URL nor the key is on a command line.
			expect(upload).not.toContain("sig1");
			expect(upload).not.toContain("DATAKEY");
			const configPath = [...vm.files.keys()].find((path) =>
				path.includes("/.ytimesy/claude-direct/"),
			) as string;
			expect(JSON.parse(vm.files.get(configPath) ?? "")).toMatchObject({
				dataKey: "DATAKEY",
				header: "v2.wrapped",
			});
			expect(upload).toContain(configPath);
			expect(
				vm.shell.mock.calls.some(
					([command]) => command === `rm -f '${configPath}'`,
				),
			).toBe(true);
		});

		it("keeps the previous backup, and the turn, when the VM upload fails", async () => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			withSize(vm, 12 * 1024 * 1024, 1);
			const step = input(vm, {
				store: store({
					direct: direct(),
					readSession: vi.fn(async () => ({
						claudeSessionId: CLAUDE_SESSION,
						transcriptPath: "prefix/last-good.enc",
						cwd: CWD,
					})),
				}),
			});
			await expect(runClaudeCodeStep(step)).resolves.toMatchObject({
				outcome: "completed",
			});
			expect(step.store.saveSession).toHaveBeenCalledWith({
				claudeSessionId: CLAUDE_SESSION,
				transcriptPath: "prefix/last-good.enc",
				cwd: CWD,
			});
		});

		it("falls back to the inline guard when no direct channel is available, or the transcript is beyond 128 MiB", async () => {
			for (const [bytes, channel] of [
				[12 * 1024 * 1024, direct({ prepareUpload: vi.fn(async () => null) })],
				[200 * 1024 * 1024, direct()],
			] as const) {
				const vm = new FakeVm();
				vm.emit(init, success);
				vm.status = "0";
				withSize(vm, bytes);
				const step = input(vm, { store: store({ direct: channel }) });
				await runClaudeCodeStep(step);
				expect(nodeCommands(vm)).toHaveLength(0);
				expect(step.store.uploadTranscript).not.toHaveBeenCalled();
				expect(step.store.saveSession).toHaveBeenCalledWith({
					claudeSessionId: CLAUDE_SESSION,
					transcriptPath: null,
					cwd: CWD,
				});
			}
		});

		it("restores a direct backup onto a new machine without the Durable Object downloading it", async () => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			withSize(vm, 1024);
			const path = `prefix/claude-code-${CLAUDE_SESSION}.direct`;
			const channel = direct();
			const saved = store({
				direct: channel,
				readSession: vi.fn(async () => ({
					claudeSessionId: CLAUDE_SESSION,
					transcriptPath: path,
					cwd: CWD,
				})),
			});
			const step = input(vm, {
				store: saved,
				messages: [
					{ role: "user", content: "First." },
					{ role: "assistant", content: "Done first." },
					{ role: "user", content: "Second." },
				],
			});
			await runClaudeCodeStep(step);
			expect(channel.prepareDownload).toHaveBeenCalledWith(path);
			expect(saved.downloadTranscript).not.toHaveBeenCalled();
			const [download] = nodeCommands(vm);
			expect(download).toContain("direct restore failed");
			expect(download).toContain(
				`${HOME}/.ytimesy/claude-code/projects/-home-ubuntu-repo/${CLAUDE_SESSION}.jsonl`,
			);
			expect(download).not.toContain("sig2");
			expect(
				JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").resume,
			).toBe(CLAUDE_SESSION);
		});

		it("starts a fresh session when a direct restore fails", async () => {
			const vm = new FakeVm();
			vm.emit(init, success);
			vm.status = "0";
			withSize(vm, 1024, 1);
			const step = input(vm, {
				store: store({
					direct: direct(),
					readSession: vi.fn(async () => ({
						claudeSessionId: CLAUDE_SESSION,
						transcriptPath: `prefix/claude-code-${CLAUDE_SESSION}.direct`,
						cwd: CWD,
					})),
				}),
				messages: [
					{ role: "user", content: "First." },
					{ role: "assistant", content: "Done first." },
					{ role: "user", content: "Second." },
				],
			});
			await expect(runClaudeCodeStep(step)).resolves.toMatchObject({
				outcome: "completed",
			});
			expect(
				JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").resume,
			).toBeNull();
		});
	});

	it("runs a read-only helper as the reader user without write tools", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const prepareReader = vi.fn(async () => {});
		await runClaudeCodeStep(input(vm, { reader: true, prepareReader }));
		expect(prepareReader).toHaveBeenCalled();
		const launch = vm.launched[0] ?? "";
		expect(launch).toContain("sudo -n -u ytimesy-reader");
		expect(launch).not.toContain("unshare --net");
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").disallowedTools,
		).toEqual(
			expect.arrayContaining([
				"AskUserQuestion",
				"Bash",
				"Task",
				"TaskOutput",
				"TaskStop",
				"Write",
				"Edit",
				"MultiEdit",
				"NotebookEdit",
			]),
		);
		expect(
			vm.shell.mock.calls.some(([command]) =>
				String(command).includes("sudo -n install -o ytimesy-reader"),
			),
		).toBe(true);
	});

	it("does not append text twice when a step re-reads a line", async () => {
		const vm = new FakeVm();
		vm.emit(init, work[0], success);
		vm.status = "0";
		const step = input(vm, { hasItem: () => true });
		await runClaudeCodeStep(step);
		expect(step.events.some((event) => event.type === "text-delta")).toBe(
			false,
		);
	});
});

/** The chat object's side of a run's feed, as the step sees it. */
function fakeFeed(clock: () => number) {
	const states = new Map<number, ClaudeFeedState>();
	const stored: { offset: number; next: number; line: string }[] = [];
	const consumed: [number, number][] = [];
	const feed: ClaudeCodeFeed = {
		state: (run) => states.get(run) ?? null,
		lines: (_run, from, limit) =>
			stored.filter((line) => line.offset >= from).slice(0, limit),
		consume: (run, to) => {
			consumed.push([run, to]);
		},
		wait: async () => {},
	};
	/** The runner said hello and sent these messages. */
	const push = (...events: unknown[]) => {
		let offset = stored.at(-1)?.next ?? 0;
		for (const event of events) {
			const line = JSON.stringify(event);
			const next = offset + Buffer.byteLength(line) + 1;
			stored.push({ offset, next, line });
			offset = next;
		}
		states.set(1, {
			run: 1,
			receivedTo: offset,
			consumedTo: states.get(1)?.consumedTo ?? 0,
			lastSeen: clock(),
			exitStatus: null,
		});
	};
	return { feed, states, stored, consumed, push };
}

describe("Claude Code runner: feed or poll", () => {
	const isPoll = (command: string) =>
		command.startsWith("python3 -c") && / -?\d+ 524288$/.test(command);
	/** A run already going on the machine, launched by an earlier step. */
	const attached = () => {
		const vm = new FakeVm();
		vm.files.set(`${RUNS}/current`, "1");
		vm.files.set(`${RUNS}/1/started`, "1");
		return vm;
	};

	it("follows the run's feed instead of polling once its runner said hello", async () => {
		const vm = attached();
		const clock = 1_000_000;
		const fed = fakeFeed(() => clock);
		fed.push(init, ...work, success);
		const step = input(vm, { feed: fed.feed });
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("completed");
		expect(vm.shell.mock.calls.some(([command]) => isPoll(command))).toBe(
			false,
		);
		expect(
			step.events.filter((event) => event.type === "tool-call").length,
		).toBeGreaterThan(0);
		const end = fed.stored.at(-1)?.next ?? 0;
		expect(fed.consumed.at(-1)).toEqual([1, end]);
		// The run is marked read on the machine too, at the same offset.
		expect(vm.files.get(`${RUNS}/1/offset`)).toBe(String(end));
		expect(vm.files.has(`${RUNS}/1/consumed`)).toBe(true);
	});

	it("reads the same events from the feed as from the out file", async () => {
		const polled = attached();
		polled.emit(init, ...work, success);
		const fromPoll = input(polled);
		await runClaudeCodeStep(fromPoll);
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init, ...work, success);
		const fromFeed = input(attached(), { feed: fed.feed });
		await runClaudeCodeStep(fromFeed);
		expect(fromFeed.events).toEqual(fromPoll.events);
	});

	it("polls as before when no hello came (an old runner, or the feed is off)", async () => {
		const vm = attached();
		vm.emit(init, ...work, success);
		const fed = fakeFeed(() => 1_000_000);
		const result = await runClaudeCodeStep(input(vm, { feed: fed.feed }));
		expect(result.outcome).toBe("completed");
		expect(vm.shell.mock.calls.some(([command]) => isPoll(command))).toBe(true);
	});

	it("hands a silent runner's run back to polling, from where the feed left off", async () => {
		const vm = attached();
		vm.emit(init, ...work, success);
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init);
		const read = fed.stored[0]?.next ?? 0;
		fed.states.set(1, {
			run: 1,
			receivedTo: read,
			consumedTo: read,
			lastSeen: 1_000_000 - 61_000,
			exitStatus: null,
		});
		const step = input(vm, { feed: fed.feed });
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("completed");
		const firstPoll = vm.shell.mock.calls
			.map(([command]) => command)
			.find(isPoll);
		// The poll resumes at the feed's cursor (it writes it as the offset).
		expect(firstPoll).toMatch(new RegExp(` ${read} 524288$`));
	});

	it("parks the turn instead of pausing it where the executor can park", async () => {
		const vm = attached();
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init, ...work);
		const requestPause = vi.fn();
		const requestPark = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => true,
			requestPause,
			requestPark,
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(requestPark).toHaveBeenCalledOnce();
		expect(requestPause).not.toHaveBeenCalled();
		expect(fed.consumed.at(-1)).toEqual([1, fed.stored.at(-1)?.next]);
	});

	it("ends at once with nothing to read and nobody watching, keeping its place", async () => {
		const vm = attached();
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init, ...work);
		const requestPause = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => true,
			requestPause,
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(requestPause).toHaveBeenCalledWith(CLAUDE_STEP_PAUSE_MS);
		expect(fed.consumed.at(-1)).toEqual([1, fed.stored.at(-1)?.next]);
		expect(vm.shell.mock.calls.some(([command]) => isPoll(command))).toBe(
			false,
		);
	});

	it("starts where the last committed step stopped", async () => {
		const vm = attached();
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init, ...work);
		// Read through the first assistant message (its tool call was shown).
		const read = fed.stored[1]?.next ?? 0;
		fed.states.set(1, {
			...(fed.states.get(1) as ClaudeFeedState),
			consumedTo: read,
		});
		const step = input(vm, { feed: fed.feed, mayPause: () => true });
		await runClaudeCodeStep(step);
		// Only the lines after the cursor: the first assistant message is not re-read.
		expect(
			step.events.some(
				(event) => event.type === "tool-call" && event.id === "toolu_1",
			),
		).toBe(false);
	});

	it("does not end while a tool call is answering", async () => {
		const vm = attached();
		let clock = 1_000_000;
		const fed = fakeFeed(() => clock);
		fed.push(init, ...work);
		let busy = 3;
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => true,
			now: () => clock,
			bridge: {
				pump: vi.fn(),
				busy: () => busy > 0,
				wait: async (ms) => {
					busy--;
					clock += ms;
					fed.states.set(1, {
						...(fed.states.get(1) as ClaudeFeedState),
						lastSeen: clock,
					});
				},
			},
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(busy).toBe(0);
	});

	it("fails the turn when the runner reports an exit without a result", async () => {
		const vm = attached();
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init);
		fed.states.set(1, {
			...(fed.states.get(1) as ClaudeFeedState),
			exitStatus: "1",
		});
		await expect(
			runClaudeCodeStep(input(vm, { feed: fed.feed })),
		).rejects.toThrow(ClaudeCodeRunFailure);
		expect(vm.files.has(`${RUNS}/1/consumed`)).toBe(true);
	});

	it("preserves the read offset when hello arrives after an empty poll", async () => {
		const vm = attached();
		vm.emit(init, ...work);
		const fed = fakeFeed(() => 1_000_000);
		const step = input(vm, { feed: fed.feed });
		const polls = vm.shell.getMockImplementation();
		let pollCount = 0;
		vm.shell.mockImplementation(async (command: string, timeoutMs?: number) => {
			const answer = await (
				polls as (
					c: string,
					t?: number,
				) => Promise<{
					exitCode: number;
					stdout: string;
					stderr: string;
				}>
			)(command, timeoutMs);
			if (isPoll(command) && ++pollCount === 2) fed.push(init);
			return answer;
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		const read = Buffer.byteLength(vm.out);
		expect(fed.consumed.at(-1)).toEqual([1, read]);
		expect(vm.files.get(`${RUNS}/1/offset`)).toBe(String(read));
	});

	it("counts what an earlier step read when it pauses after an empty poll", async () => {
		const vm = attached();
		vm.emit(init, ...work);
		// An earlier step read all of it and saved the machine's offset.
		const read = Buffer.byteLength(vm.out);
		vm.files.set(`${RUNS}/1/offset`, String(read));
		const fed = fakeFeed(() => 1_000_000);
		const requestPause = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => true,
			requestPause,
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(requestPause).toHaveBeenCalledWith(CLAUDE_STEP_PAUSE_MS);
		// The feed starts after what was read: nothing is shown twice.
		expect(fed.consumed.at(-1)).toEqual([1, read]);
		expect(step.events).toEqual([]);
		expect(step.onPlan).not.toHaveBeenCalled();
		expect(vm.files.get(`${RUNS}/1/offset`)).toBe(String(read));
	});

	it("counts what an earlier step read when its deadline comes after an empty poll", async () => {
		const vm = attached();
		vm.emit(init, ...work);
		const read = Buffer.byteLength(vm.out);
		vm.files.set(`${RUNS}/1/offset`, String(read));
		const fed = fakeFeed(() => 1_000_000);
		const step = input(vm, { feed: fed.feed, deadline: 1_000_000 + 1_000 });
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(fed.consumed.at(-1)).toEqual([1, read]);
		expect(step.events).toEqual([]);
	});

	it("never moves the machine's offset back to an older feed position", async () => {
		const vm = attached();
		vm.emit(init, ...work);
		const read = Buffer.byteLength(vm.out);
		vm.files.set(`${RUNS}/1/offset`, String(read));
		// A feed step stopped earlier than the machine's offset (the runner
		// went silent): the poll starts from the further of the two.
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init);
		const older = fed.stored[0]?.next ?? 0;
		fed.states.set(1, {
			run: 1,
			receivedTo: older,
			consumedTo: older,
			lastSeen: 1_000_000 - 61_000,
			exitStatus: null,
		});
		const step = input(vm, { feed: fed.feed, mayPause: () => true });
		await runClaudeCodeStep(step);
		expect(vm.files.get(`${RUNS}/1/offset`)).toBe(String(read));
		expect(fed.consumed.at(-1)).toEqual([1, read]);
		expect(step.events).toEqual([]);
	});

	it("ends a feed step that read everything even while someone watches", async () => {
		const vm = attached();
		const fed = fakeFeed(() => 1_000_000);
		fed.push(init, ...work);
		const requestPause = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			// Watched: a polling step stays; a feed step may end.
			mayPause: () => false,
			mayPauseOnFeed: () => true,
			requestPause,
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(requestPause).toHaveBeenCalledWith(CLAUDE_STEP_PAUSE_MS);
		expect(fed.consumed.at(-1)).toEqual([1, fed.stored.at(-1)?.next]);
		expect(vm.shell.mock.calls.some(([command]) => isPoll(command))).toBe(
			false,
		);
	});

	it("keeps a watched feed step while a tool call answers, then ends it", async () => {
		const vm = attached();
		let clock = 1_000_000;
		const fed = fakeFeed(() => clock);
		fed.push(init, ...work);
		let busy = 2;
		const requestPause = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => false,
			mayPauseOnFeed: () => true,
			requestPause,
			now: () => clock,
			bridge: {
				pump: vi.fn(),
				busy: () => busy > 0,
				wait: async (ms) => {
					busy--;
					clock += ms;
				},
			},
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(busy).toBe(0);
		expect(requestPause).toHaveBeenCalledWith(CLAUDE_STEP_PAUSE_MS);
	});

	it("without the feed's own rule, a watched feed step stays until its deadline", async () => {
		const vm = attached();
		let clock = 1_000_000;
		const fed = fakeFeed(() => clock);
		fed.push(init, ...work);
		const requestPause = vi.fn();
		const step = input(vm, {
			feed: fed.feed,
			mayPause: () => false,
			requestPause,
			now: () => clock,
			deadline: clock + 5_000,
			bridge: {
				pump: vi.fn(),
				busy: () => false,
				wait: async (ms) => {
					clock += ms;
					fed.states.set(1, {
						...(fed.states.get(1) as ClaudeFeedState),
						lastSeen: clock,
					});
				},
			},
		});
		const result = await runClaudeCodeStep(step);
		expect(result.outcome).toBe("continue");
		expect(requestPause).not.toHaveBeenCalled();
		expect(clock).toBeGreaterThanOrEqual(1_005_000);
	});

	it("logs one line per step with its source, time awake and lines read", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const stepEnds = () =>
			info.mock.calls
				.map(([line]) => {
					try {
						return JSON.parse(String(line));
					} catch {
						return null;
					}
				})
				.filter((entry) => entry?.event === "claude.step_end");
		try {
			const fed = fakeFeed(() => 1_000_000);
			fed.push(init, ...work, success);
			await runClaudeCodeStep(input(attached(), { feed: fed.feed }));
			expect(stepEnds()).toEqual([
				{
					event: "claude.step_end",
					turnId: TURN,
					source: "feed",
					awakeMs: expect.any(Number),
					linesConsumed: fed.stored.length,
				},
			]);
			info.mockClear();
			const polled = attached();
			polled.emit(init, ...work, success);
			await runClaudeCodeStep(
				input(polled, { feed: fakeFeed(() => 1_000_000).feed }),
			);
			expect(stepEnds()).toEqual([
				expect.objectContaining({
					source: "poll",
					linesConsumed: 2 + work.length,
				}),
			]);
			// With the feed off, nothing new is logged.
			info.mockClear();
			const off = attached();
			off.emit(init, ...work, success);
			await runClaudeCodeStep(input(off));
			expect(stepEnds()).toEqual([]);
		} finally {
			info.mockRestore();
		}
	});

	it("gives the runner a feed address only where the feed is on", async () => {
		const vm = new FakeVm();
		const fed = fakeFeed(() => 1_000_000);
		await runClaudeCodeStep(
			input(vm, { feed: fed.feed, mayPause: () => true }),
		);
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").feed,
		).toEqual({
			url: `wss://edge.example${CLAUDE_CODE_FEED_PATH}`,
			turnId: TURN,
			run: 1,
		});
		const off = new FakeVm();
		await runClaudeCodeStep(input(off, { mayPause: () => true }));
		expect(
			JSON.parse(off.files.get(`${RUNS}/1/options.json`) ?? "").feed,
		).toBeUndefined();
	});
});

describe("Claude Code runner: workspace tools on the runner box", () => {
	const BOX_TOOLS = ["bash", "read", "write", "edit"];
	const remote = { repository: "/home/ubuntu/app", workspaceTools: BOX_TOOLS };
	const boxTools = (
		grant: () => Promise<{
			vmId: string;
			linuxUser: string;
			token: string;
		} | null>,
	) => ({
		tools: BOX_TOOLS,
		shape: "core" as const,
		redact: () => ["ghs_turn_git_token"],
		grant: vi.fn(grant),
		bundle: () => ({
			source: "export const startBoxTools = 1;",
			version: "a".repeat(32),
		}),
	});

	it("puts the bundle on the box once, then gives the run its grant file and the module to import", async () => {
		const vm = new FakeVm();
		const tools = boxTools(async () => ({
			vmId: "vm-1",
			linuxUser: "ubuntu",
			token: "fs-identity-token",
		}));
		const step = input(vm, { remote, boxTools: tools });
		const writeFile = vi.fn(step.writeFile);
		await runClaudeCodeStep({ ...step, writeFile, mayPause: () => true });
		const module = `${HOME}/.ytimesy/claude-box-tools/${"a".repeat(32)}.mjs`;
		expect(writeFile).toHaveBeenCalledWith(
			module,
			"export const startBoxTools = 1;",
		);
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").boxTools,
		).toEqual({ module, config: "box-tools.json" });
		expect(JSON.parse(vm.files.get(`${RUNS}/1/box-tools.json`) ?? "")).toEqual({
			token: "fs-identity-token",
			vmId: "vm-1",
			linuxUser: "ubuntu",
			cwd: "/home/ubuntu/app",
			sessionId: SESSION,
			turnId: TURN,
			shape: "core",
			tools: BOX_TOOLS,
			redact: ["ghs_turn_git_token"],
		});
		// The token is redacted from the turn and never in the launch command.
		expect(step.addRedaction).toHaveBeenCalledWith("fs-identity-token");
		expect(vm.launched.join("\n")).not.toContain("fs-identity-token");
		expect(tools.grant).toHaveBeenCalledOnce();
		// A later run on the same box finds the bundle there.
		const again = new FakeVm();
		again.files.set(module, "export const startBoxTools = 1;");
		const writeAgain = vi.fn(input(again).writeFile);
		await runClaudeCodeStep({
			...input(again, { remote, boxTools: tools }),
			writeFile: writeAgain,
			mayPause: () => true,
		});
		expect(writeAgain).not.toHaveBeenCalledWith(module, expect.anything());
	});

	it("keeps every tool on the edge when the grant is refused or the run is not on a box", async () => {
		const refused = new FakeVm();
		await runClaudeCodeStep(
			input(refused, {
				remote,
				boxTools: boxTools(async () => null),
				mayPause: () => true,
			}),
		);
		expect(
			JSON.parse(refused.files.get(`${RUNS}/1/options.json`) ?? "").boxTools,
		).toBeUndefined();
		expect(refused.files.has(`${RUNS}/1/box-tools.json`)).toBe(false);
		const local = new FakeVm();
		const tools = boxTools(async () => ({
			vmId: "vm-1",
			linuxUser: "ubuntu",
			token: "t",
		}));
		await runClaudeCodeStep(
			input(local, { boxTools: tools, mayPause: () => true }),
		);
		expect(tools.grant).not.toHaveBeenCalled();
	});

	it("shows the run's box tool calls from its stream once the runner says which tools it serves", async () => {
		const vm = new FakeVm();
		vm.files.set(`${RUNS}/current`, "1");
		vm.files.set(`${RUNS}/1/started`, "1");
		vm.files.set(`${RUNS}/1/box-tools-active`, JSON.stringify(["read"]));
		vm.emit(
			init,
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu_read",
							name: "mcp__ytimesy__read",
							input: { path: "a.ts" },
						},
						{
							type: "tool_use",
							id: "toolu_agent",
							name: "mcp__ytimesy__agent",
							input: {},
						},
					],
				},
			},
			{
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_read",
							content: "1 line",
						},
					],
				},
			},
			success,
		);
		vm.status = "0";
		const step = input(vm, {
			remote,
			boxTools: boxTools(async () => null),
		});
		await runClaudeCodeStep(step);
		const shown = step.events.filter(
			(event) => event.type === "tool-call" || event.type === "tool-result",
		);
		expect(shown).toEqual([
			{
				type: "tool-call",
				id: "toolu_read",
				name: "read",
				input: { path: "a.ts" },
			},
			{ type: "tool-result", id: "toolu_read", name: "read", output: "1 line" },
		]);
	});

	it("the actual SDK wrapper serves box tools locally and keeps the edge for the inbox", () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-wrapper-"));
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`import { writeFileSync } from "node:fs";
export async function* query({ options }) {
	writeFileSync(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify(options.mcpServers));
	yield { type: "result" };
}`,
			);
			writeFileSync(
				join(directory, "box.mjs"),
				`import { readFileSync, writeFileSync } from "node:fs";
export async function startBoxTools(input) {
	writeFileSync(${JSON.stringify(join(directory, "box-input.json"))}, JSON.stringify({ edge: input.edge, config: JSON.parse(readFileSync(input.configPath, "utf8")) }));
	return { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer local" }, local: ["read", "bash"], close: async () => {} };
}`,
			);
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({
					model: "local-test",
					disallowedTools: [],
					boxTools: {
						module: join(directory, "box.mjs"),
						config: "box-tools.json",
					},
				}),
			);
			writeFileSync(
				join(directory, "box-tools.json"),
				JSON.stringify({ token: "fs-identity-token" }),
			);
			const edge = {
				type: "http",
				url: "https://edge.example/claude/mcp",
				headers: { Authorization: "Bearer grant" },
			};
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({ mcpServers: { ytimesy: edge } }),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			execFileSync(
				process.execPath,
				[
					join(directory, "runner.mjs"),
					join(directory, "sdk.mjs"),
					directory,
					directory,
				],
				{ encoding: "utf8" },
			);
			expect(
				JSON.parse(readFileSync(join(directory, "seen.json"), "utf8")),
			).toEqual({
				ytimesy: {
					type: "http",
					url: "http://127.0.0.1:9/mcp",
					headers: { Authorization: "Bearer local" },
				},
			});
			expect(
				JSON.parse(readFileSync(join(directory, "box-input.json"), "utf8")),
			).toEqual({
				edge: { url: edge.url, headers: edge.headers },
				config: { token: "fs-identity-token" },
			});
			expect(
				JSON.parse(readFileSync(join(directory, "box-tools-active"), "utf8")),
			).toEqual(["read", "bash"]);
			// The grant file is gone once the run started.
			expect(() => readFileSync(join(directory, "box-tools.json"))).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("the actual SDK wrapper keeps every tool on the edge when the box tools do not start", () => {
		const directory = mkdtempSync(join(tmpdir(), "claude-wrapper-"));
		try {
			writeFileSync(join(directory, "runner.mjs"), CLAUDE_AGENT_RUNNER_SCRIPT);
			writeFileSync(
				join(directory, "sdk.mjs"),
				`import { writeFileSync } from "node:fs";
export async function* query({ options }) {
	writeFileSync(${JSON.stringify(join(directory, "seen.json"))}, JSON.stringify(options.mcpServers));
	yield { type: "result" };
}`,
			);
			writeFileSync(
				join(directory, "options.json"),
				JSON.stringify({
					model: "local-test",
					disallowedTools: [],
					boxTools: {
						module: join(directory, "missing.mjs"),
						config: "box-tools.json",
					},
				}),
			);
			writeFileSync(join(directory, "box-tools.json"), "{}");
			const edge = {
				type: "http",
				url: "https://edge.example/claude/mcp",
				headers: {},
			};
			writeFileSync(
				join(directory, "mcp.json"),
				JSON.stringify({ mcpServers: { ytimesy: edge } }),
			);
			writeFileSync(join(directory, "system"), "Local functional test.");
			writeFileSync(join(directory, "prompt"), "Return a result.");
			execFileSync(
				process.execPath,
				[
					join(directory, "runner.mjs"),
					join(directory, "sdk.mjs"),
					directory,
					directory,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
			expect(
				JSON.parse(readFileSync(join(directory, "seen.json"), "utf8")),
			).toEqual({
				ytimesy: edge,
			});
			expect(() => readFileSync(join(directory, "box-tools.json"))).toThrow();
			expect(() => readFileSync(join(directory, "box-tools-active"))).toThrow();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Y² on a runner box (no machine)", () => {
	const Y_CWD = `/var/lib/ytimesy-runner/work/${SESSION}`;
	const instructions = "You are Y², the project's super agent.";
	const ySquared = (vm: FakeVm, overrides: Partial<ClaudeCodeStepInput> = {}) =>
		input(vm, {
			cwd: Y_CWD,
			remote: { repository: Y_CWD, workspaceTools: [] },
			ySquared: { instructions },
			...overrides,
		});
	const transcript = `${HOME}/.ytimesy/claude-code/projects/${claudeCodeProjectDirectory(Y_CWD)}/${CLAUDE_SESSION}.jsonl`;

	it("writes its own prompt and an options file with every native tool off", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		vm.files.set(transcript, '{"type":"user"}\n');
		await runClaudeCodeStep(ySquared(vm));
		const options = JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "");
		// No native tool at all, and a by-name list that also names the ones
		// the shared list leaves on.
		expect(options.builtInTools).toEqual([]);
		expect(options.disallowedTools).toEqual(
			expect.arrayContaining([
				"Bash",
				"Read",
				"Task",
				"WebFetch",
				"WebSearch",
				"TodoWrite",
				"Skill",
				"ExitPlanMode",
			]),
		);
		const system = vm.files.get(`${RUNS}/1/system`) ?? "";
		expect(system).toContain(instructions);
		expect(system).toContain("mcp__ytimesy__*");
		for (const gone of [
			"The repository is at",
			"run_code",
			"ytimesy-browser",
			"ytimesy-job",
			"request_project_secret",
			"agent_send",
			"canvas",
		])
			expect(system).not.toContain(gone);
		// Its own working directory, not the shared one.
		expect(vm.launched[0]).toContain(`'${RUNS}/1/runner.mjs'`);
		expect(vm.launched[0]).toContain(`'${Y_CWD}'`);
		expect(vm.launched[0]).not.toContain("'/var/lib/ytimesy-runner/work'");
	});

	it("leaves a normal chat's options and prompt as they were", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		await runClaudeCodeStep(input(vm));
		const options = JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "");
		expect(options).not.toHaveProperty("builtInTools");
		expect(options.disallowedTools).not.toContain("WebFetch");
		expect(vm.files.get(`${RUNS}/1/system`)).toContain(
			"mcp__ytimesy__run_code",
		);
	});

	it("resumes the stored session from the per-chat transcript and saves it back there", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		vm.files.set(transcript, '{"type":"user"}\n');
		const saveSession = vi.fn(async () => {});
		await runClaudeCodeStep(
			ySquared(vm, {
				messages: [
					{ role: "user", content: "first" },
					{ role: "assistant", content: "ok" },
					{ role: "user", content: "and now?" },
				],
				store: store({
					readSession: vi.fn(async () => ({
						claudeSessionId: CLAUDE_SESSION,
						transcriptPath: "prefix/x.enc",
						cwd: Y_CWD,
					})),
					saveSession,
				}),
			}),
		);
		const options = JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "");
		expect(options.resume).toBe(CLAUDE_SESSION);
		expect(vm.files.get(`${RUNS}/1/prompt`)).toBe("and now?");
		expect(saveSession).toHaveBeenCalledWith(
			expect.objectContaining({ claudeSessionId: CLAUDE_SESSION, cwd: Y_CWD }),
		);
	});

	it("restores a stored session onto the box when the file is gone", async () => {
		const vm = new FakeVm();
		vm.emit(init, success);
		vm.status = "0";
		const downloadTranscript = vi.fn(async () => '{"type":"user"}\n');
		await runClaudeCodeStep(
			ySquared(vm, {
				store: store({
					readSession: vi.fn(async () => ({
						claudeSessionId: CLAUDE_SESSION,
						transcriptPath: "prefix/x.enc",
						cwd: Y_CWD,
					})),
					downloadTranscript,
				}),
			}),
		);
		expect(downloadTranscript).toHaveBeenCalledWith("prefix/x.enc");
		expect(vm.files.get(transcript)).toBe('{"type":"user"}\n');
		expect(
			JSON.parse(vm.files.get(`${RUNS}/1/options.json`) ?? "").resume,
		).toBe(CLAUDE_SESSION);
	});
});
