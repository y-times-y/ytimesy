import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionItemId, WorkspaceId } from "#/domain/ids";
import type { SessionItem } from "#/domain/session-item";
import {
	backgroundCommandsRunningOn,
	settleBackgroundIdleTimeout,
	settleIdleTimeoutAfterTurn,
} from "./background-idle-timeout";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const cleanup: string[] = [];
const processes: ChildProcess[] = [];
const vm = WorkspaceId("vm");

afterEach(async () => {
	for (const child of processes.splice(0)) child.kill("SIGKILL");
	await Promise.all(
		cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
	vi.restoreAllMocks();
});

/** Runs guest commands on this machine, as the VM would. */
function hostMachines(overrides: Partial<WorkspaceMachines> = {}) {
	const exec = vi.fn(async (_vm: unknown, command: string) => {
		try {
			const output = await run("bash", ["-c", command]);
			return { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
		} catch (error) {
			const failed = error as { code: number; stdout: string; stderr: string };
			return {
				exitCode: failed.code,
				stdout: failed.stdout,
				stderr: failed.stderr,
			};
		}
	});
	return {
		exec,
		settleIdleTimeout: vi.fn(async () => undefined),
		keepAwakeForBackground: vi.fn(async () => undefined),
		...overrides,
	} as unknown as WorkspaceMachines & {
		exec: typeof exec;
		settleIdleTimeout: ReturnType<typeof vi.fn>;
		keepAwakeForBackground: ReturnType<typeof vi.fn>;
	};
}

/** A machine's command roots: two chats' (a parent and a helper sharing its VM). */
async function roots() {
	const directory = await mkdtemp(join(tmpdir(), "ytimesy-idle-"));
	cleanup.push(directory);
	return directory;
}

/** A background command of chat `session` as the launch leaves it on the machine. */
async function command(
	directory: string,
	session: string,
	state: "running" | "exited" | "vanished",
) {
	const id = crypto.randomUUID();
	const root = join(directory, session);
	await run("mkdir", ["-p", root]);
	await writeFile(join(root, `${id}.background`), "{}");
	const script = join(root, `${id}.sh`);
	await writeFile(script, "sleep 30\n");
	if (state === "exited") await writeFile(join(root, `${id}.status`), "0\n");
	if (state === "running") {
		const child = spawn("bash", [script], { stdio: "ignore" });
		processes.push(child);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return id;
}

// Real guest scripts and processes: generous under a loaded test run.
describe("which background commands run on a machine", {
	timeout: 30_000,
}, () => {
	it("counts every chat's running command, not exited or vanished ones", async () => {
		const directory = await roots();
		await command(directory, "parent", "exited");
		await command(directory, "parent", "vanished");
		const helper = await command(directory, "helper", "running");
		expect(
			await backgroundCommandsRunningOn(hostMachines(), vm, directory),
		).toEqual([helper]);
		expect(
			await backgroundCommandsRunningOn(
				hostMachines(),
				vm,
				join(directory, "missing"),
			),
		).toEqual([]);
	});
});

describe("settling a VM's idle timeout", { timeout: 30_000 }, () => {
	it("gives the VM the short timeout back once nothing runs on it", async () => {
		const directory = await roots();
		await command(directory, "chat", "exited");
		const machines = hostMachines();
		expect(
			await settleBackgroundIdleTimeout(machines, vm, { roots: directory }),
		).toBe("settled");
		expect(machines.settleIdleTimeout).toHaveBeenCalledExactlyOnceWith(vm);
		expect(machines.keepAwakeForBackground).not.toHaveBeenCalled();
	});

	it("never lowers it while another chat's command still runs on the VM", async () => {
		const directory = await roots();
		await command(directory, "parent", "exited");
		await command(directory, "helper", "running");
		const machines = hostMachines();
		expect(
			await settleBackgroundIdleTimeout(machines, vm, { roots: directory }),
		).toBe("kept");
		expect(machines.settleIdleTimeout).not.toHaveBeenCalled();
		expect(machines.keepAwakeForBackground).toHaveBeenCalledWith(vm);
	});

	it("raises it again when a command started while it was lowered", async () => {
		const directory = await roots();
		const machines = hostMachines();
		machines.settleIdleTimeout.mockImplementation(async () => {
			await command(directory, "helper", "running");
		});
		expect(
			await settleBackgroundIdleTimeout(machines, vm, { roots: directory }),
		).toBe("kept");
		expect(machines.keepAwakeForBackground).toHaveBeenCalledWith(vm);
	});

	it("leaves the timeout alone when the machine cannot say, and never throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const unreadable = hostMachines({
			exec: vi.fn(async () => ({ exitCode: 2, stdout: "", stderr: "" })),
		});
		expect(await settleBackgroundIdleTimeout(unreadable, vm)).toBe("failed");
		expect(unreadable.settleIdleTimeout).not.toHaveBeenCalled();
		const refused = hostMachines({
			settleIdleTimeout: vi.fn(async () => {
				throw new Error("provider down");
			}),
		});
		expect(
			await settleBackgroundIdleTimeout(refused, vm, {
				roots: await roots(),
			}),
		).toBe("failed");
		expect(warn).toHaveBeenCalledWith(
			"The VM's idle timeout was not settled.",
			expect.objectContaining({ message: "provider down" }),
		);
	});

	it("costs no guest call on a provider that never pauses", async () => {
		const machines = hostMachines({ settleIdleTimeout: undefined });
		expect(await settleBackgroundIdleTimeout(machines, vm)).toBe("unsupported");
		expect(machines.exec).not.toHaveBeenCalled();
	});
});

describe("settling at a turn's end", () => {
	const card = (exitCode?: number): SessionItem => ({
		kind: "dynamicToolCall",
		id: SessionItemId(`turn:${crypto.randomUUID()}`),
		tool: "bash",
		status: "completed",
		background: {
			id: crypto.randomUUID(),
			label: "pnpm dev",
			startedAt: 1_000,
			...(exitCode === undefined ? {} : { exitCode, endedAt: 2_000 }),
		},
	});

	it("settles only a chat that ran background commands and has none open", async () => {
		const machines = hostMachines();
		const workspace = vi.fn(async () => ({ machines, vm, cwd: "/" }));
		const settle = vi.fn(async () => "settled" as const);
		expect(
			await settleIdleTimeoutAfterTurn({ workspace, items: [] }, settle),
		).toBe("skipped");
		expect(
			await settleIdleTimeoutAfterTurn(
				{ workspace, items: [card(0), card()] },
				settle,
			),
		).toBe("skipped");
		expect(workspace).not.toHaveBeenCalled();
		expect(
			await settleIdleTimeoutAfterTurn(
				{ workspace, items: [card(0), card(1)] },
				settle,
			),
		).toBe("settled");
		expect(settle).toHaveBeenCalledExactlyOnceWith(machines, vm);
	});

	it("never fails the turn when its machine is not available", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(
			await settleIdleTimeoutAfterTurn({
				workspace: async () => {
					throw new Error("no machine");
				},
				items: [{ ...card(0) }],
			}),
		).toBe("failed");
	});
});
