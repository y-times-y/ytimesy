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

	it("runs the saved install in the checkout, waits for it, then adds one note", async () => {
		const machine = guest("exit 0\n");
		const deps = dependencies();
		const result = await withSetupCatchUp(input(machine.workspace), deps);
		expect(result.changed).toBe(true);
		expect(result.messages).toHaveLength(2);
		const note = String(result.messages[1]?.content);
		expect(note).toContain("ran on this machine and passed");
		expect(note).toContain("web (`pnpm dev`, port 3000)");
		const launch = machine.commands.find((command) =>
			command.includes("echo started"),
		);
		expect(launch).toContain("/home/ubuntu/web");
		expect(launch).toContain("corepack pnpm install --frozen-lockfile");
		// It waits for the boot's own install before running.
		expect(launch).toContain(".ytimesy/install.status");
		// Waited at most the cap, inside the step's deadline.
		expect(machine.commands.at(-1)).toContain("seq 0 150");
		expect(deps.finished).toEqual(["chat"]);
	});

	it("names an install that failed or still runs, and the chat continues", async () => {
		const failed = await withSetupCatchUp(
			input(guest("exit 2\n").workspace),
			dependencies(),
		);
		expect(String(failed.messages[1]?.content)).toContain("failed (exit 2");
		const running = await withSetupCatchUp(
			{ ...input(guest("running\n").workspace), waitUntil: 10_000 },
			dependencies(),
		);
		expect(String(running.messages[1]?.content)).toContain("still running");
	});

	it("tells the agent when its machine could not run the install", async () => {
		const deps = dependencies();
		const result = await withSetupCatchUp(
			input(async () => {
				throw new Error("The machine is not responding.");
			}),
			deps,
		);
		expect(String(result.messages[1]?.content)).toContain(
			"could not be run on this machine (The machine is not responding.)",
		);
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
