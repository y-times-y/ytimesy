import { describe, expect, it, vi } from "vitest";
import type { ApiAgentEvent } from "#/domain/api-agent-event";
import {
	ClaudeCodeApiUnavailable,
	ClaudeSubscriptionLimitReached,
	ClaudeSubscriptionRefused,
} from "#/domain/api-turn-failure";
import { CLAUDE_AGENT_RUNNER_SCRIPT } from "#/domain/claude-agent-runner";
import { verifyClaudeCodeGrant } from "#/domain/claude-code-grant";
import { CLAUDE_AGENT_SDK_MODULE } from "#/domain/guest-cli-pin";
import {
	type ClaudeCodeStepInput,
	type ClaudeCodeStore,
	claudeCodeCommandId,
	runClaudeCodeStep,
	stopClaudeCodeRun,
} from "./claude-code-runner";

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
			if (Number(commit) >= 0) this.files.set(`${dir}/offset`, commit);
			const offset = Number(this.files.get(`${dir}/offset`) ?? "0");
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
			disallowedTools: ["AskUserQuestion"],
			resume: null,
		});
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
		).toEqual([
			"AskUserQuestion",
			"Write",
			"Edit",
			"MultiEdit",
			"NotebookEdit",
		]);
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
