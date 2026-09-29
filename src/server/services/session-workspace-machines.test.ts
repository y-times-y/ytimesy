import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

	it("keeps Codex daemon state inside the shared session root", () => {
		const source = readFileSync(
			"src/server/adapters/codex/login-daemon.py",
			"utf8",
		);
		const output = execFileSync(
			"python3",
			[
				"-c",
				"import json, sys; scope={'__name__':'scoped_test'}; exec(compile(sys.stdin.read(), 'login-daemon.py', 'exec'), scope); print(json.dumps([scope['STATUS_PATH'], scope['STATE_PATH'], scope['TASK_REQUEST_PATH'], scope['STOP_REQUEST_PATH']]))",
			],
			{
				input: scopeSessionRuntimeText(source, "task-123"),
				encoding: "utf8",
				env: { ...process.env, YTIMESY_RUNTIME_ROOT: "" },
			},
		);
		const root = sessionRuntimeRoot("task-123");
		expect(JSON.parse(output)).toEqual([
			`${root}/ytimesy-auth-status.json`,
			`${root}/ytimesy-codex-thread-state.json`,
			`${root}/ytimesy-task-request.json`,
			`${root}/ytimesy-stop-request.json`,
		]);
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
