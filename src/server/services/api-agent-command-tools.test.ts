import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	apiAgentCommandTools,
	verifyPatchedCheckout,
} from "./api-agent-command-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
const commandRoots: string[] = [];

it("can verify without formatting when no formatting stage is required", async () => {
	const check = vi.fn().mockResolvedValue([{ exitCode: 0, stopped: null }]);
	expect(
		await verifyPatchedCheckout({
			signal: new AbortController().signal,
			check,
		}),
	).toEqual({ formatting: null, checks: [{ exitCode: 0, stopped: null }] });
	expect(check).toHaveBeenCalledTimes(1);
});

it("orders formatting before verification and preserves each stage's evidence", async () => {
	const sequence: string[] = [];
	const formatting = {
		exitCode: 0,
		stopped: null,
		reference: "format-output",
		stdout: "formatted",
		stderr: "warning retained",
		stdoutNextStart: null,
		stderrNextStart: null,
	};
	const checks = [
		{ command: "check", exitCode: 1, stopped: null, reference: "check-output" },
	];
	expect(
		await verifyPatchedCheckout({
			signal: new AbortController().signal,
			format: async () => {
				sequence.push("format");
				return formatting;
			},
			check: async () => {
				sequence.push("check");
				return checks;
			},
		}),
	).toEqual({ formatting, checks });
	expect(sequence).toEqual(["format", "check"]);
});

it.each([
	{ exitCode: 1, stopped: null },
	{ exitCode: 0, stopped: "timeout" as const },
	{ exitCode: 0, stopped: "output_limit" as const },
])("does not verify failed or interrupted formatting: %o", async (failure) => {
	const check = vi.fn();
	const formatting = {
		...failure,
		reference: "failure-output",
		stdout: "",
		stderr: "actual error",
		stdoutNextStart: null,
		stderrNextStart: null,
	};
	expect(
		await verifyPatchedCheckout({
			signal: new AbortController().signal,
			format: async () => formatting,
			check,
		}),
	).toEqual({ formatting, checks: null });
	expect(check).not.toHaveBeenCalled();
});

it("honors cancellation between formatting and checks and never suppresses execution errors", async () => {
	const controller = new AbortController();
	const check = vi.fn();
	await expect(
		verifyPatchedCheckout({
			signal: controller.signal,
			format: async () => {
				controller.abort();
				return {
					exitCode: 0,
					stopped: null,
					reference: "output",
					stdout: "",
					stderr: "",
					stdoutNextStart: null,
					stderrNextStart: null,
				};
			},
			check,
		}),
	).rejects.toThrow();
	expect(check).not.toHaveBeenCalled();
	await expect(
		verifyPatchedCheckout({
			signal: new AbortController().signal,
			check: async () => {
				throw new Error("Transport uncertain");
			},
		}),
	).rejects.toThrow("Transport uncertain");
});
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
	await Promise.all(
		commandRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(readOnly = false) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-command-tools-"));
	roots.push(root);
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			try {
				const output = await run("bash", ["-lc", command]);
				return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
			} catch (error) {
				const failed = error as Error & {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: failed.code,
					stdout: failed.stdout,
					stderr: failed.stderr,
				};
			}
		},
	} as unknown as WorkspaceMachines;
	const sessionId = crypto.randomUUID();
	commandRoots.push(`/tmp/ytimesy-api-commands/${sessionId}`);
	const tools = apiAgentCommandTools({
		machines,
		vm: WorkspaceId("test-vm"),
		cwd: root,
		sessionId,
		turnId: sessionId,
		readOnly,
		signal: new AbortController().signal,
		once: async (_id, execute) => execute(),
	});
	return { tools, commands };
}

async function call(tool: unknown, input: object) {
	return (
		tool as { execute: (args: object, options: object) => Promise<unknown> }
	).execute(input, { toolCallId: crypto.randomUUID() });
}

it("runs independent checks with bounded concurrency, ordered evidence and replay protection", async () => {
	let active = 0;
	let peak = 0;
	let sequence = 0;
	const capture = vi.fn(async () => {
		const index = sequence++;
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, index === 0 ? 25 : 5));
		active--;
		return {
			reference: `evidence-${index}`,
			exitCode: index === 1 ? 1 : 0,
			stopped: index === 2 ? ("timeout" as const) : null,
			stdout: "retained diagnostic",
			stderr: "",
			stdoutNextStart: index === 0 ? 32000 : null,
			stderrNextStart: null,
		};
	});
	const receipts = new Map<string, unknown>();
	const input = {
		machines: {} as WorkspaceMachines,
		vm: WorkspaceId("test"),
		cwd: "/repo",
		sessionId: crypto.randomUUID(),
		turnId: crypto.randomUUID(),
		readOnly: false,
		signal: new AbortController().signal,
		once: async (id: string, run: () => Promise<unknown>) => {
			if (!receipts.has(id)) receipts.set(id, await run());
			return receipts.get(id);
		},
		output: { capture } as unknown as ReturnType<typeof agentOutputArtifacts>,
	};
	const tools = apiAgentCommandTools(input);
	const check = tools.run_checks as {
		execute: (args: object, options: object) => Promise<unknown>;
	};
	const args = { commands: ["lint", "test", "build"] };
	const result = await check.execute(args, { toolCallId: "checks" });
	expect(peak).toBe(2);
	expect(result).toMatchObject([
		{
			command: "lint",
			passed: true,
			reference: "evidence-0",
			stdoutNextStart: 32000,
		},
		{ command: "test", passed: false, exitCode: 1 },
		{ command: "build", passed: false, stopped: "timeout" },
	]);
	expect(await check.execute(args, { toolCallId: "checks" })).toEqual(result);
	expect(capture).toHaveBeenCalledTimes(3);
	expect(
		apiAgentCommandTools({ ...input, readOnly: true }).run_checks,
	).toBeUndefined();
	await expect(
		check.execute({ commands: [] }, { toolCallId: "empty" }),
	).rejects.toThrow();
	await expect(
		check.execute(
			{ commands: ["test"], maxSeconds: 121 },
			{ toolCallId: "too-long" },
		),
	).rejects.toThrow();
});

it("keeps long-running commands out of the read-only lead", async () => {
	const { tools } = await fixture(true);
	expect(Object.keys(tools)).toEqual(["read_command"]);
});

it.runIf(process.platform === "linux")(
	"defers unfinished wait output without advancing its cursor and preserves live reads",
	async () => {
		const { tools } = await fixture();
		const started = (await call(tools.start_command, {
			command: "printf 'early-output\\n'; sleep 4; printf 'finished\\n'",
			maxSeconds: 15,
		})) as { id: string };
		try {
			expect(
				await call(tools.wait_command, { id: started.id, seconds: 1 }),
			).toMatchObject({
				status: "running",
				stdout: "",
				start: 0,
				nextStart: 0,
				outputDeferred: true,
			});
			expect(await call(tools.read_command, { id: started.id })).toMatchObject({
				status: "running",
				stdout: "early-output\n",
			});
			expect(
				await call(tools.wait_command, { id: started.id, seconds: 5 }),
			).toMatchObject({ status: 0, stdout: "early-output\nfinished\n" });
		} finally {
			await call(tools.stop_command, { id: started.id });
		}
	},
	15_000,
);

it.runIf(process.platform === "linux")(
	"runs and polls a command in an isolated tmux session",
	async () => {
		const { tools } = await fixture();
		const started = (await call(tools.start_command, {
			command: "printf 'command-complete\\n'",
			maxSeconds: 30,
		})) as { id: string };
		let output: { status: number | string; stdout: string } = {
			status: "running",
			stdout: "",
		};
		for (let attempt = 0; attempt < 20; attempt++) {
			output = (await call(tools.wait_command, {
				id: started.id,
				seconds: 1,
			})) as typeof output;
			if (output.status === 0) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(output.status).toBe(0);
		expect(output.stdout).toContain("command-complete");
	},
);
