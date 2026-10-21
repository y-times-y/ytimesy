import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	machinesForAgentSession,
	scopeSessionRuntimeText,
	sessionRuntimeRoot,
	sessionScopedWorkspaceMachines,
} from "./session-workspace-machines";
import type { WorkspaceMachines } from "./workspace-machines";

describe("session workspace machines", () => {
	it("keeps external Codex token and refresh files private to each shared session", () => {
		const root = sessionRuntimeRoot("task-123");
		expect(
			scopeSessionRuntimeText(
				"/tmp/ytimesy-codex-external-tokens.json /tmp/ytimesy-codex-refresh-request.json /tmp/ytimesy-codex-refresh-response.json",
				"task-123",
			),
		).toBe(
			`${root}/ytimesy-codex-external-tokens.json ${root}/ytimesy-codex-refresh-request.json ${root}/ytimesy-codex-refresh-response.json`,
		);
	});

	it("gives a writing grandchild the unscoped machine after a reader child", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		const machines = { exec } as unknown as WorkspaceMachines;
		const sharedChild = machinesForAgentSession(machines, {
			taskPlacement: "shared",
			id: "shared-child",
			agentRole: "researcher",
		});
		const writingGrandchild = machinesForAgentSession(sharedChild, {
			taskPlacement: "fresh",
			id: "writing-grandchild",
			agentRole: "writer",
		});
		await writingGrandchild.exec(WorkspaceId("vm-grandchild"), "pwd");
		expect(writingGrandchild).toBe(machines);
		expect(exec).toHaveBeenCalledWith(WorkspaceId("vm-grandchild"), "pwd");
	});

	it("runs lead mode fusion's shared writer on its parent's VM as the builder's user, with its own runtime root", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		const machines = { exec } as unknown as WorkspaceMachines;
		const sidekick = machinesForAgentSession(machines, {
			id: "sidekick",
			agentRole: "writer",
			taskPlacement: "shared",
		});
		expect(sidekick).not.toBe(machines);
		await sidekick.exec(
			WorkspaceId("vm-lead"),
			"cat /tmp/ytimesy-codex-external-tokens.json",
		);
		const command = (exec.mock.calls[0] as unknown as [unknown, string])[1];
		expect(command).toContain("sidekick");
		expect(command).not.toContain("ytimesy-reader");
	});

	it("maps adapter reads, writes, and commands into one session root", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		const writeTextFile = vi.fn(async () => undefined);
		const readTextFile = vi.fn(async () => "ok");
		const machines = {
			exec,
			writeTextFile,
			readTextFile,
		} as unknown as WorkspaceMachines;
		const scoped = sessionScopedWorkspaceMachines(machines, "task-123");
		const workspaceId = WorkspaceId("vm-1");

		await scoped.writeTextFile(
			workspaceId,
			"/tmp/ytimesy-codex-external-tokens.json",
			"/tmp/ytimesy-codex-refresh-request.json",
		);
		await scoped.readTextFile(
			workspaceId,
			"/tmp/ytimesy-codex-external-tokens.json",
		);
		await scoped.exec(
			workspaceId,
			"rm /tmp/ytimesy-codex-refresh-response.json",
		);

		const root = sessionRuntimeRoot("task-123");
		expect(writeTextFile).toHaveBeenCalledWith(
			workspaceId,
			`${root}/ytimesy-codex-external-tokens.json`,
			`${root}/ytimesy-codex-refresh-request.json`,
		);
		expect(readTextFile).toHaveBeenCalledWith(
			workspaceId,
			`${root}/ytimesy-codex-external-tokens.json`,
		);
		expect(exec).toHaveBeenLastCalledWith(
			workspaceId,
			`mkdir -p '${root}'\nrm ${root}/ytimesy-codex-refresh-response.json`,
			undefined,
		);
	});
});
