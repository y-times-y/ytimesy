import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { listProjectCommands } from "./workspace-explorer";
import type { WorkspaceMachines } from "./workspace-machines";

vi.mock("./agent-session-machine", () => ({
	peekAgentSessionMachine: async () => ({ providerRef: "vm-1" }),
}));
vi.mock("../adapters/projects", () => ({
	projectForOwner: async () => ({
		fullName: "owner/repo",
		branch: "main",
		repositoryId: 1,
		installationId: 1,
	}),
}));

it("lists repository slash commands from the running checkout with the real reader", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-commands-"));
	try {
		await mkdir(join(root, ".claude/commands"), { recursive: true });
		await mkdir(join(root, ".agents/commands"), { recursive: true });
		await writeFile(
			join(root, ".claude/commands/review.md"),
			"---\ndescription: Review the diff\n---\nReview $ARGUMENTS carefully.",
		);
		await writeFile(join(root, ".agents/commands/review.md"), "Duplicate");
		await writeFile(
			join(root, ".agents/commands/ship.md"),
			"Prepare a release.",
		);
		await writeFile(
			join(root, ".claude/commands/stop.md"),
			"Shadows a built-in",
		);
		await writeFile(join(root, "outside.md"), "secret");
		await symlink(
			join(root, "outside.md"),
			join(root, ".claude/commands/leak.md"),
		);
		const machines = {
			isRunning: async () => true,
			readTextFile: async () => `${root}\n`,
			exec: async (_id: unknown, command: string) => {
				const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
				return {
					exitCode: result.status ?? 1,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
		} as unknown as WorkspaceMachines;
		const commands = await Effect.runPromise(
			listProjectCommands(machines, { userId: "alice", projectId: "p1" }),
		);
		expect(
			commands.map((command) => [command.trigger, command.description]),
		).toEqual([
			["/review", "Review the diff"],
			["/ship", "Prepare a release."],
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("returns nothing, without waking it, when the machine is paused", async () => {
	const exec = vi.fn();
	const machines = {
		isRunning: async () => false,
		readTextFile: vi.fn(),
		exec,
	} as unknown as WorkspaceMachines;
	expect(
		await Effect.runPromise(
			listProjectCommands(machines, { userId: "alice", projectId: "p1" }),
		),
	).toEqual([]);
	expect(exec).not.toHaveBeenCalled();
});
