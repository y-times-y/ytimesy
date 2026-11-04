import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import {
	type SetupCatchUpDependencies,
	withSetupCatchUp,
} from "./fresh-machine-setup";

const history: ModelMessage[] = [{ role: "user", content: "Add a login page" }];

function guest(statusOutput = "exit 0\n") {
	const commands: string[] = [];
	return {
		commands,
		workspace: async () => ({
			vm: WorkspaceId("vm-chat"),
			machines: {
				exec: async (_vm: WorkspaceId, command: string) => {
					commands.push(command);
					if (command.startsWith("printf"))
						return { exitCode: 0, stdout: "/home/ubuntu", stderr: "" };
					if (command.includes("echo started"))
						return { exitCode: 0, stdout: "started\n", stderr: "" };
					return { exitCode: 0, stdout: statusOutput, stderr: "" };
				},
				writeTextFile: async () => {},
			},
		}),
	};
}

function dependencies(
	overrides: Partial<SetupCatchUpDependencies> = {},
): SetupCatchUpDependencies & { finished: string[] } {
	const finished: string[] = [];
	return {
		finished,
		take: async () => true,
		finish: async (sessionId) => {
			finished.push(sessionId);
		},
		repositories: async () => [
			{
				fullName: "acme/web",
				recipe: {
					install: "corepack pnpm install --frozen-lockfile",
					services: [
						{
							name: "web",
							command: "pnpm dev",
							port: 3000,
							timeoutSeconds: 60,
						},
					],
				},
			},
		],
		...overrides,
	};
}

const input = (workspace: ReturnType<typeof guest>["workspace"]) => ({
	sessionId: "chat",
	userId: "owner",
	projectId: "project",
	messages: history,
	workspace,
	waitUntil: 1_000_000,
	now: () => 0,
});

describe("withSetupCatchUp", () => {
	it("does nothing (no machine call) until the project's setup is saved", async () => {
		const machine = guest();
		const workspace = vi.fn(machine.workspace);
		const deps = dependencies({ take: async () => false });
		const result = await withSetupCatchUp(input(workspace), deps);
		expect(result).toEqual({ messages: history, changed: false });
		expect(workspace).not.toHaveBeenCalled();
		expect(deps.finished).toEqual([]);
	});

	it("never touches the running chat's machine: one note says what setup saved", async () => {
		const machine = guest();
		const workspace = vi.fn(machine.workspace);
		const deps = dependencies();
		const result = await withSetupCatchUp(input(workspace), deps);
		expect(result.changed).toBe(true);
		expect(result.messages).toHaveLength(2);
		const note = String(result.messages[1]?.content);
		expect(note).toContain(
			"Its install command is `corepack pnpm install --frozen-lockfile`",
		);
		expect(note).toContain("nothing was changed here");
		expect(note).toContain("web (`pnpm dev`, port 3000)");
		// No install, no waiting: the machine is never called.
		expect(workspace).not.toHaveBeenCalled();
		expect(machine.commands).toEqual([]);
		expect(deps.finished).toEqual(["chat"]);
	});

	it("runs nothing on the machine when the setup saved no install", async () => {
		const machine = guest();
		const workspace = vi.fn(machine.workspace);
		const result = await withSetupCatchUp(
			input(workspace),
			dependencies({
				repositories: async () => [
					{ fullName: "acme/web", recipe: { services: [] } },
				],
			}),
		);
		expect(String(result.messages[1]?.content)).toContain(
			"nothing was installed here",
		);
		expect(workspace).not.toHaveBeenCalled();
	});
});
