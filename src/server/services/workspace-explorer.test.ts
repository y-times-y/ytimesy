import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
	parseWorkspaceDiffOutput,
	WORKSPACE_DIFF_TRUNCATED_NOTE,
} from "#/domain/git-diff";
import { gitChangesScript, listProjectCommands } from "./workspace-explorer";
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

it("returns a capped diff with a truncation note instead of failing on huge changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-diff-"));
	try {
		const git = (...args: string[]) =>
			spawnSync("git", [
				"-C",
				root,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				...args,
			]);
		git("init", "-q");
		await writeFile(join(root, "small.txt"), "one\n");
		await writeFile(join(root, "big.txt"), "seed\n");
		git("add", ".");
		git("commit", "-qm", "base");
		await writeFile(join(root, "small.txt"), "two\n");
		await writeFile(
			join(root, "big.txt"),
			"x".repeat(99).concat("\n").repeat(50_000),
		);
		const result = spawnSync("bash", ["-c", gitChangesScript(root, "")], {
			maxBuffer: 64 * 1024 * 1024,
		});
		expect(result.status).toBe(0);
		const { changes, truncated } = parseWorkspaceDiffOutput(
			result.stdout.toString(),
		);
		expect(truncated).toBe(true);
		expect(changes.map((change) => change.path)).toContain("big.txt");
		expect(changes.at(-1)?.preview).toContain(WORKSPACE_DIFF_TRUNCATED_NOTE);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("leaves an ordinary diff unmarked", () => {
	const { changes, truncated } = parseWorkspaceDiffOutput(
		"diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
	);
	expect(truncated).toBe(false);
	expect(changes).toHaveLength(1);
	expect(changes[0]?.preview).not.toContain("truncated");
});
