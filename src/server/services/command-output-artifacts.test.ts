import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	apiAgentCommandTools,
	completedAgentCommands,
} from "./api-agent-command-tools";
import type { WorkspaceMachines } from "./workspace-machines";

// Linux /proc-based ownership has separate tests. This fixture verifies real tmux/capture transport on macOS.
vi.mock("./api-command-scope", () => ({
	scopedShellCommand: ({ command }: { command: string }) => command,
	stopApiCommand: async () => {},
}));
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(waitDeadlineAt?: number) {
	const cwd = await mkdtemp(join(tmpdir(), "ytimesy-command-output-"));
	const sessionId = randomUUID();
	roots.push(
		cwd,
		`/tmp/ytimesy-api-commands/${sessionId}`,
		`/tmp/ytimesy-output-${createHash("sha256").update(sessionId).digest("hex")}`,
	);
	const machines = {
		exec: async (_vm: string, command: string) => {
			try {
				return { ...(await run("bash", ["-lc", command])), exitCode: 0 };
			} catch (error) {
				const result = error as {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: result.code,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			}
		},
	} as unknown as WorkspaceMachines;
	const workspace = { machines, vm: WorkspaceId("local"), cwd };
	const signal = new AbortController().signal;
	const output = agentOutputArtifacts({ ...workspace, sessionId, signal });
	const tools = apiAgentCommandTools({
		...workspace,
		sessionId,
		turnId: sessionId,
		readOnly: false,
		signal,
		output,
		once: async (_id, fn) => fn(),
		waitDeadlineAt,
	});
	const call = async (name: string, args: object) =>
		(
			tools[name] as {
				execute: (input: object, options: object) => Promise<unknown>;
			}
		).execute(args, { toolCallId: randomUUID() });
	return { call, workspace, sessionId, signal };
}

it("yields a running command, accepts literal stdin and resumes without reexecution", async () => {
	const { call } = await fixture();
	const started = (await call("execute_command", {
		command: `python3 -u -c 'import sys; print("READY", flush=True); value=input(); print("RECEIVED:"+value, flush=True)'`,
		maxSeconds: 30,
		yieldSeconds: 1,
	})) as { id: string; status: string; stdout: string };
	expect(started).toMatchObject({
		status: "running",
		stdout: expect.stringContaining("READY"),
	});
	const completed = await call("continue_command", {
		id: started.id,
		chars: "literal '; $(not-a-command)\n",
		seconds: 2,
	});
	expect(completed).toMatchObject({
		id: started.id,
		status: 0,
		stdout: expect.stringContaining("RECEIVED:literal '; $(not-a-command)"),
	});
	await expect(
		call("continue_command", {
			id: started.id,
			chars: "late input",
			seconds: 0,
		}),
	).rejects.toThrow("not running");
});

it("returns completed commands without requiring a second model request", async () => {
	const { call } = await fixture();
	expect(
		await call("execute_command", {
			command: "printf immediate",
			maxSeconds: 30,
			yieldSeconds: 2,
		}),
	).toMatchObject({ status: 0, stdout: "immediate", nextStart: null });
});

it("waits for a running command in one call and returns partial output with a newer-output cursor when cut short", async () => {
	const { call } = await fixture();
	const started = (await call("execute_command", {
		command: "printf 'early\\n'; sleep 3; printf 'finished\\n'",
		maxSeconds: 30,
		yieldSeconds: 0,
	})) as { id: string };
	const peek = (await call("continue_command", {
		id: started.id,
		seconds: 1,
	})) as { status: string; stdout: string; nextStart: number };
	expect(peek).toMatchObject({
		status: "running",
		stdout: "early\n",
		nextStart: 6,
		waitedSeconds: expect.any(Number),
	});
	expect(
		await call("continue_command", { id: started.id, start: peek.nextStart }),
	).toMatchObject({ status: 0, stdout: "finished\n", nextStart: null });
});

it("ends a wait at the step deadline and says so", async () => {
	const { call } = await fixture(Date.now() - 1);
	const started = (await call("execute_command", {
		command: "printf 'early\\n'; sleep 5",
		maxSeconds: 30,
		yieldSeconds: 0,
	})) as { id: string };
	const before = Date.now();
	expect(
		await call("continue_command", { id: started.id, seconds: 300 }),
	).toMatchObject({
		status: "running",
		note: expect.stringContaining("time left in this step"),
	});
	expect(Date.now() - before).toBeLessThan(5_000);
	await call("stop_command", { id: started.id });
});

it("sends EOF to an owned interactive command and retains failed exits", async () => {
	const { call } = await fixture();
	const started = (await call("execute_command", {
		command: `python3 -u -c 'import sys; data=sys.stdin.read(); print("BYTES:"+str(len(data))); sys.exit(3)'`,
		maxSeconds: 30,
		yieldSeconds: 0,
	})) as { id: string };
	expect(
		await call("continue_command", { id: started.id, eof: true, seconds: 2 }),
	).toMatchObject({ status: 3, stdout: expect.stringContaining("BYTES:0") });
});

it("waits without model polling and retrieves complete background output beyond the initial page", async () => {
	const { call, workspace, sessionId, signal } = await fixture();
	const started = (await call("start_command", {
		command:
			'python3 -c \'import sys; print("你" * 32010, end=""); print("ERROR_END", file=sys.stderr)\'',
		maxSeconds: 30,
	})) as { id: string };
	const first = (await call("wait_command", {
		id: started.id,
		seconds: 2,
	})) as { status: number; stdout: string; nextStart: number | null };
	expect(first).toMatchObject({ status: 0, nextStart: 32000 });
	expect(first.stdout).toHaveLength(32000);
	expect(
		await completedAgentCommands({
			...workspace,
			sessionId,
			signal,
			ids: [started.id],
		}),
	).toEqual([{ id: started.id, status: 0, stopped: null }]);
	const other = await fixture();
	expect(
		await completedAgentCommands({
			...other.workspace,
			sessionId: other.sessionId,
			signal: other.signal,
			ids: [started.id],
		}),
	).toEqual([{ id: started.id, status: "interrupted", stopped: null }]);
	const next = await call("read_command", { id: started.id, start: 32000 });
	expect(next).toMatchObject({
		status: 0,
		nextStart: null,
		stdout: expect.stringContaining("ERROR_END"),
	});
});

it("marks output-limit termination as incomplete rather than reporting a successful check", async () => {
	const { call } = await fixture();
	const started = (await call("start_command", {
		command: "python3 -c 'print(\"x\" * 17000000)'",
		maxSeconds: 30,
	})) as { id: string };
	const result = await call("wait_command", { id: started.id, seconds: 2 });
	expect(result).toMatchObject({ status: 125, stopped: "output_limit" });
});
