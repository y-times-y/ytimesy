import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	ClaudeCodeRunFailure,
	ClaudeRunnerRequired,
} from "#/domain/api-turn-failure";
import type { ClaudeRunnerBox } from "#/domain/claude-runner";
import { requestClaudeCodeCall } from "./claude-code-bridge";
import { runClaudeCodeStep, stopClaudeCodeRun } from "./claude-code-runner";

const boxShell = vi.fn(async (_command: string, _timeoutMs: number) => ({
	exitCode: 0,
	stdout: "",
	stderr: "",
}));
vi.mock("./claude-code-runner", () => ({
	runClaudeCodeStep: vi.fn(),
	stopClaudeCodeRun: vi.fn(),
}));
vi.mock("../adapters/github/git-proxy-transfer", () => ({
	gitProxyConfiguration: () => ({
		origin: "https://edge.example",
		secret: "test-only-grant-secret",
	}),
}));
vi.mock("../adapters/claude-subscription", () => ({
	claudeSubscriptionTokenForRedaction: async () => null,
}));
vi.mock("../adapters/claude-runner-box", () => ({
	// The fake runner box: nothing leaves the process.
	claudeRunnerMachine: () => ({
		shell: boxShell,
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => null),
	}),
	claudeRunnerDiskShare: async () => 0.1,
}));

import {
	runClaudeCodeTurnStep,
	stopClaudeCodeTurnRun,
} from "./claude-code-turn";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TURN = "22222222-2222-4222-8222-222222222222";
const box: ClaudeRunnerBox = { baseUrl: "https://box.example" };

/** Any use of a machine fails the test: Y² has none. */
const noMachines = new Proxy(
	{},
	{
		get(_target, name) {
			throw new Error(`Y² touched machines.${String(name)}`);
		},
	},
);

function turn(overrides: Record<string, unknown> = {}) {
	return {
		userId: "u",
		sessionId: SESSION,
		turnId: TURN,
		modelId: "claude-sonnet-5-5",
		agentRole: null,
		machines: noMachines,
		messages: [],
		tools: {},
		deadline: Date.now() + 1000,
		signal: new AbortController().signal,
		redact: () => [],
		addRedaction: () => {},
		hasItem: () => false,
		toolName: () => undefined,
		onEvent: async () => {},
		onPlan: () => {},
		ySquared: { instructions: "You are Y²." },
		runner: { box, workspaceTools: [] },
		...overrides,
	} as unknown as Parameters<typeof runClaudeCodeTurnStep>[0];
}

describe("a Claude Code turn without a machine (Y²)", () => {
	beforeEach(() => {
		vi.mocked(runClaudeCodeStep).mockReset();
		boxShell.mockClear();
	});

	it("runs on the box in a per-chat directory and never reaches a machine", async () => {
		let step: Parameters<typeof runClaudeCodeStep>[0] | undefined;
		vi.mocked(runClaudeCodeStep).mockImplementationOnce(async (input) => {
			step = input;
			await input.beforeLaunch?.();
			// The box is the only host: shell, writes and reads go to it.
			await input.shell("true", 1000);
			await input.writeFile("/x", "y");
			await input.readFile("/x");
			return { messages: [], outcome: "completed" };
		});
		await runClaudeCodeTurnStep(turn());
		expect(step?.cwd).toBe(`/var/lib/ytimesy-runner/work/${SESSION}`);
		expect(step?.ySquared).toEqual({ instructions: "You are Y²." });
		expect(step?.remote).toEqual({
			repository: `/var/lib/ytimesy-runner/work/${SESSION}`,
			workspaceTools: [],
		});
		expect(step?.boxTools).toBeUndefined();
		expect(step?.prepareReader).toBeUndefined();
		expect(boxShell).toHaveBeenCalledWith(
			`mkdir -p -- '/var/lib/ytimesy-runner/work/${SESSION}'`,
			30_000,
		);
	});

	it("serves the six Y² tools over the bridge without a machine", async () => {
		const names = [
			"threads",
			"thread",
			"ask_user",
			"start_thread",
			"message_thread",
			"stop_thread",
		];
		const ran: string[] = [];
		const tools = Object.fromEntries(
			names.map((name) => [
				name,
				tool({
					description: name,
					inputSchema: z.object({}),
					execute: async () => {
						ran.push(name);
						return name;
					},
				}),
			]),
		);
		vi.mocked(runClaudeCodeStep).mockImplementationOnce(async (input) => {
			const asked = names.map((name) => requestClaudeCodeCall(TURN, name, {}));
			input.bridge.pump();
			await Promise.all(asked);
			return { messages: [], outcome: "completed" };
		});
		await runClaudeCodeTurnStep(turn({ tools }));
		expect(ran.sort()).toEqual([...names].sort());
	});

	it("needs a runner: without one it throws ClaudeRunnerRequired and starts nothing", async () => {
		vi.mocked(runClaudeCodeStep).mockClear();
		await expect(
			runClaudeCodeTurnStep(turn({ runner: undefined })),
		).rejects.toBeInstanceOf(ClaudeRunnerRequired);
		expect(runClaudeCodeStep).not.toHaveBeenCalled();
	});

	it("refuses a machine-less turn that is not Y²", async () => {
		await expect(
			runClaudeCodeTurnStep(turn({ ySquared: undefined })),
		).rejects.toThrow(/must be Y²/);
	});

	it("fails the launch, not the turn's machine, when the box cannot make its directory", async () => {
		boxShell.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "" });
		vi.mocked(runClaudeCodeStep).mockImplementationOnce(async (input) => {
			await input.beforeLaunch?.();
			return { messages: [], outcome: "completed" };
		});
		await expect(runClaudeCodeTurnStep(turn())).rejects.toBeInstanceOf(
			ClaudeCodeRunFailure,
		);
	});

	it("Stop reaches the box with a null VM", async () => {
		vi.mocked(stopClaudeCodeRun).mockClear();
		vi.mocked(stopClaudeCodeRun).mockResolvedValue(undefined);
		await stopClaudeCodeTurnRun({
			machines: noMachines as never,
			vm: null,
			turnId: TURN,
			runner: box,
		});
		expect(stopClaudeCodeRun).toHaveBeenCalledOnce();
		const shell = vi.mocked(stopClaudeCodeRun).mock.calls[0]?.[0];
		await shell?.("kill", 1000);
		expect(boxShell).toHaveBeenCalledWith("kill", 1000);
	});
});
