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
}));
const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
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
	});
	const call = async (name: string, args: object) =>
		(
			tools[name] as {
				execute: (input: object, options: object) => Promise<unknown>;
			}
		).execute(args, { toolCallId: randomUUID() });
	return { call, workspace, sessionId, signal };
}

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
