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
			id: "shared-child",
			agentRole: "researcher",
		});
		const writingGrandchild = machinesForAgentSession(sharedChild, {
			id: "writing-grandchild",
			agentRole: "writer",
		});
		await writingGrandchild.exec(WorkspaceId("vm-grandchild"), "pwd");
		expect(writingGrandchild).toBe(machines);
		expect(exec).toHaveBeenCalledWith(WorkspaceId("vm-grandchild"), "pwd");
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
