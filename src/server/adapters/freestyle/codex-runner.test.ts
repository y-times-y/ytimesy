import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import {
	codexRunnerIdentity,
	codexRunnerMachines,
	codexRunnerRoot,
	deleteFreestyleCodexSession,
	resolveFreestyleCodexRuntime,
	scopeCodexRuntimeText,
} from "./codex-runner";

const provider = vi.hoisted(() => ({ list: vi.fn(), ref: vi.fn() }));
vi.mock("freestyle", () => ({
	Freestyle: class {
		vms = provider;
	},
	FreestyleApiError: class extends Error {},
}));

describe("isolated Codex runtime routing", () => {
	it("cleans only the verified chat directory even when provider files are root-owned", async () => {
		const identity = codexRunnerIdentity("cleanup-user");
		const exec = vi.fn(
			async (_options: { command: string; timeoutMs: number }) => ({
				statusCode: 0,
			}),
		);
		provider.list.mockResolvedValueOnce({
			vms: [
				{
					id: "runner",
					state: "running",
					metadata: { purpose: "ytimesy-codex-runner", owner: identity.owner },
				},
			],
		});
		provider.ref.mockReturnValueOnce({
			exec,
			data: async () => ({ state: "running" }),
		});
		await deleteFreestyleCodexSession("key", "cleanup-user", "cleanup-chat");
		expect(exec).toHaveBeenCalledWith(
			expect.objectContaining({
				command: expect.stringContaining(
					`sudo -n rm -rf -- '${codexRunnerRoot("cleanup-chat")}'`,
				),
			}),
		);
		expect(exec.mock.calls[0][0].command).not.toContain(
			"sudo -n rm -rf -- '/home/ubuntu/.ytimesy-codex'",
		);
	});
	it("uses stable collision-resistant owner and session identities without raw user data", () => {
		expect(codexRunnerIdentity("user@example.com")).toEqual(
			codexRunnerIdentity("user@example.com"),
		);
		expect(codexRunnerIdentity("user@example.com").slug).not.toContain(
			"user@example.com",
		);
		expect(codexRunnerRoot("task/1")).not.toBe(codexRunnerRoot("task1"));
		expect(codexRunnerRoot("../secret")).toMatch(
			/^\/home\/ubuntu\/\.ytimesy-codex\/[a-f0-9]{32}$/,
		);
	});
	it("scopes native state and preparation metadata, never the project checkout", () => {
		const root = codexRunnerRoot("session");
		expect(
			scopeCodexRuntimeText(
				"/tmp/ytimesy-auth-status.json /tmp/ytimesy-project-cwd /home/ubuntu/project",
				"session",
			),
		).toBe(
			`${root}/ytimesy-auth-status.json ${root}/ytimesy-project-cwd /home/ubuntu/project`,
		);
	});
	it("routes native reads, commands and credential writes to the runner with an isolated HOME", async () => {
		const base = {
			exec: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
			readTextFile: vi.fn(async () => null),
			writeTextFile: vi.fn(async () => undefined),
		} as unknown as WorkspaceMachines;
		const runnerId = WorkspaceId("runner");
		const executorId = WorkspaceId("executor");
		const runtime = codexRunnerMachines(base, {
			runnerId,
			executorId,
			sessionId: "session",
			executorUrl: "wss://executor.internal",
		});
		await runtime.machines.exec(
			executorId,
			"cat /tmp/ytimesy-codex-thread-state.json",
			1000,
		);
		expect(base.exec).toHaveBeenCalledWith(
			runnerId,
			expect.stringContaining(`export HOME='${runtime.root}/home'`),
			1000,
		);
		expect(vi.mocked(base.exec).mock.calls[0][1]).toContain(
			"YTIMESY_REMOTE_EXEC_URL='wss://executor.internal'",
		);
		await runtime.machines.readTextFile(
			runnerId,
			"/tmp/ytimesy-auth-status.json",
		);
		expect(base.readTextFile).toHaveBeenCalledWith(
			runnerId,
			`${runtime.root}/ytimesy-auth-status.json`,
		);
		await runtime.machines.writeTextFile(
			runnerId,
			"/tmp/ytimesy-codex-external-tokens.json",
			"access only",
		);
		expect(base.writeTextFile).toHaveBeenCalledWith(
			runnerId,
			`${runtime.root}/ytimesy-codex-external-tokens.json`,
			"access only",
		);
		expect(() =>
			runtime.machines.exec(WorkspaceId("another-user"), "pwd"),
		).toThrow("target mismatch");
		expect(base.exec).toHaveBeenCalledTimes(1);
	});
});

describe("runner recovery boundaries", () => {
	function fixture() {
		const machines = {
			ensureRunning: vi.fn(async () => undefined),
			isRunning: vi.fn(async () => true),
			readTextFile: vi.fn(async (): Promise<string | null> => null),
			writeTextFile: vi.fn(async () => undefined),
			exec: vi.fn(),
		} as unknown as WorkspaceMachines;
		return {
			machines,
			input: {
				userId: "owner",
				sessionId: "chat",
				executorId: WorkspaceId("executor"),
				executorMachines: machines,
				provision: false,
			},
		};
	}

	it("does not provision or wake machines when reading an untouched chat", async () => {
		const { machines, input } = fixture();
		provider.list.mockResolvedValueOnce({ vms: [] });
		expect(
			await resolveFreestyleCodexRuntime("key", machines, input),
		).toBeNull();
		expect(machines.ensureRunning).not.toHaveBeenCalled();
	});

	it("does not silently replay legacy history after a migrated runner disappears", async () => {
		const { machines, input } = fixture();
		vi.mocked(machines.readTextFile).mockResolvedValue(
			JSON.stringify({ runnerId: "missing", sessionId: "chat" }),
		);
		provider.list.mockResolvedValueOnce({ vms: [] });
		await expect(
			resolveFreestyleCodexRuntime("key", machines, input),
		).rejects.toThrow("saved Codex runner is unavailable");
		expect(machines.exec).not.toHaveBeenCalled();
	});

	it("rejects another owner's machine before touching it", async () => {
		const { machines, input } = fixture();
		provider.list.mockResolvedValueOnce({
			vms: [
				{
					id: "wrong",
					slug: codexRunnerIdentity(input.userId).slug,
					metadata: { purpose: "ytimesy-codex-runner", owner: "other" },
				},
			],
		});
		await expect(
			resolveFreestyleCodexRuntime("key", machines, input),
		).rejects.toThrow("ownership");
		expect(machines.exec).not.toHaveBeenCalled();
	});

	it("rejects an executor replacement without rebinding the conversation", async () => {
		const { machines, input } = fixture();
		const identity = codexRunnerIdentity(input.userId);
		provider.list.mockResolvedValueOnce({
			vms: [
				{
					id: "runner",
					slug: identity.slug,
					metadata: { purpose: "ytimesy-codex-runner", owner: identity.owner },
					state: "running",
				},
			],
		});
		vi.mocked(machines.readTextFile).mockImplementation(async (_id, path) =>
			path.endsWith("executor.json")
				? JSON.stringify({ executorId: "original" })
				: null,
		);
		await expect(
			resolveFreestyleCodexRuntime("key", machines, input),
		).rejects.toThrow("binding has changed");
		expect(machines.writeTextFile).not.toHaveBeenCalled();
		expect(machines.exec).not.toHaveBeenCalled();
	});
});
