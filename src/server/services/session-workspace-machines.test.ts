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
	it("isolates peer mailboxes and Claude hooks on shared machines", () => {
		const text =
			"/tmp/ytimesy-peer-inbox/job.json /tmp/ytimesy-peer-hook.py /tmp/ytimesy-peer-hooks.json";
		expect(scopeSessionRuntimeText(text, "a")).not.toBe(
			scopeSessionRuntimeText(text, "b"),
		);
		expect(scopeSessionRuntimeText(text, "a")).toContain(
			"/tmp/ytimesy-sessions/a/ytimesy-peer-inbox/job.json",
		);
	});
	it("scopes conversation state but leaves shared checkout paths alone", () => {
		const sessionId = "task-123";
		expect(
			scopeSessionRuntimeText(
				"read /tmp/ytimesy-task-request.json and /tmp/ytimesy-project-cwd",
				sessionId,
			),
		).toBe(
			"read /tmp/ytimesy-sessions/task-123/ytimesy-task-request.json and /tmp/ytimesy-project-cwd",
		);
	});

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

	it("gives a writing grandchild the unscoped machine after a shared child", async () => {
		const exec = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
		const machines = { exec } as unknown as WorkspaceMachines;
		const sharedChild = machinesForAgentSession(machines, {
			id: "shared-child",
			taskPlacement: "shared",
		});
		const writingGrandchild = machinesForAgentSession(sharedChild, {
			id: "writing-grandchild",
			taskPlacement: "fresh",
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
			"/tmp/ytimesy-auth-status.json",
			"/tmp/ytimesy-task-result.json",
		);
		await scoped.readTextFile(workspaceId, "/tmp/ytimesy-auth-status.json");
		await scoped.exec(workspaceId, "rm /tmp/ytimesy-stop-request.json");

		const root = sessionRuntimeRoot("task-123");
		expect(writeTextFile).toHaveBeenCalledWith(
			workspaceId,
			`${root}/ytimesy-auth-status.json`,
			`${root}/ytimesy-task-result.json`,
		);
		expect(readTextFile).toHaveBeenCalledWith(
			workspaceId,
			`${root}/ytimesy-auth-status.json`,
		);
		expect(exec).toHaveBeenLastCalledWith(
			workspaceId,
			`mkdir -p '${root}'\nrm ${root}/ytimesy-stop-request.json`,
			undefined,
		);
	});
});
