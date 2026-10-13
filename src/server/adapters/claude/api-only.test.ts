import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import {
	connectClaudeCode,
	refreshClaudeAuthStatus,
	submitClaudeTask,
} from "./login-session";

it("fails without a key before installing or launching any login process", async () => {
	const exec = vi.fn();
	const machines = { exec } as unknown as WorkspaceMachines;
	expect(
		await Effect.runPromise(
			connectClaudeCode(machines, WorkspaceId("vm"), null),
		),
	).toMatchObject({ stage: "failed" });
	expect(exec).not.toHaveBeenCalled();
});
it("does not reuse subscription status or submit work under it", async () => {
	const exec = vi.fn();
	const machines = {
		exec,
		readTextFile: vi.fn().mockResolvedValue(
			JSON.stringify({
				stage: "authenticated",
				authMode: "subscription",
				models: [],
				items: [],
				turnStatus: "idle",
			}),
		),
	} as unknown as WorkspaceMachines;
	expect(
		await Effect.runPromise(
			refreshClaudeAuthStatus(machines, WorkspaceId("vm")),
		),
	).toMatchObject({ stage: "failed" });
	expect(
		await Effect.runPromise(
			submitClaudeTask(machines, WorkspaceId("vm"), {
				text: "test",
				modelId: "test",
			}),
		),
	).toMatchObject({ stage: "failed" });
	expect(exec).not.toHaveBeenCalled();
});

it("persists API authentication for the next request without losing the transcript", async () => {
	const path = "/tmp/ytimesy-claude-auth-status.json";
	const items = [
		{ kind: "agentMessage", id: "previous", text: "Previous answer" },
	];
	const files = new Map([
		[
			path,
			JSON.stringify({
				stage: "authenticated",
				authMode: "apikey",
				models: [],
				items,
				turnStatus: "completed",
			}),
		],
	]);
	const machines = {
		exec: vi.fn(async (_id: string, command: string) => ({
			exitCode: 0,
			stderr: "",
			stdout: command.includes("auth status")
				? '{"loggedIn":true}'
				: "CLAUDE_BIN=/usr/local/bin/claude\nCLAUDE_HOME=/home/ubuntu",
		})),
		readTextFile: vi.fn(
			async (_id: string, file: string) => files.get(file) ?? null,
		),
		writeTextFile: vi.fn(async (_id: string, file: string, content: string) => {
			files.set(file, content);
		}),
	} as unknown as WorkspaceMachines;
	const connected = await Effect.runPromise(
		connectClaudeCode(machines, WorkspaceId("vm"), "fixture-api-key"),
	);
	expect(connected).toMatchObject({
		stage: "authenticated",
		authMode: "apikey",
		turnStatus: "completed",
		items,
	});
	expect(
		await Effect.runPromise(
			refreshClaudeAuthStatus(machines, WorkspaceId("vm")),
		),
	).toEqual(connected);
	expect(files.get(path)).not.toContain("fixture-api-key");
});
