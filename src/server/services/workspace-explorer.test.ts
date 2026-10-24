import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { fetchedBranchCommand } from "#/domain/git-branch-switch";
import {
	parseWorkspaceDiffOutput,
	WORKSPACE_DIFF_TRUNCATED_NOTE,
} from "#/domain/git-diff";
import {
	gitChangesScript,
	listProjectCommands,
	listWorkspaceExplorer,
	readWorkspaceExplorerFile,
} from "./workspace-explorer";
import type { WorkspaceMachines } from "./workspace-machines";

// Each call names a new machine: the checkout directory is remembered per machine.
let machineCount = 0;
vi.mock("./agent-session-machine", () => ({
	peekAgentSessionMachine: async () => ({
		providerRef: `vm-${++machineCount}`,
	}),
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

it("lists a paused machine from its git index and reads the first file, without waking it", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-paused-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: root });
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src/app.ts"), "export {};\n");
		await writeFile(join(root, "README.md"), "# Hi\n");
		spawnSync("git", ["add", "-A"], { cwd: root });
		const exec = vi.fn();
		const isRunning = vi.fn(async () => false);
		const machines = {
			isRunning,
			exec,
			readTextFile: async (_id: unknown, path: string) =>
				path === "/tmp/ytimesy-project-cwd"
					? `${root}\n`
					: readFile(path, "utf8").catch(() => null),
			readFile: async (_id: unknown, path: string) => readFile(path),
		} as unknown as WorkspaceMachines;
		const listing = await Effect.runPromise(
			listWorkspaceExplorer(machines, {
				userId: "alice",
				projectId: "p1",
				sessionId: "paused",
			}),
		);
		expect(listing).toMatchObject({
			root,
			paths: ["README.md", "src/app.ts"],
			machine: "asleep",
			opened: { path: "src/app.ts", text: "export {};\n" },
		});
		expect(exec).not.toHaveBeenCalled();
		// Reading a file never asks whether the machine runs.
		isRunning.mockClear();
		expect(
			await Effect.runPromise(
				readWorkspaceExplorerFile(
					machines,
					{ userId: "alice", projectId: "p1", sessionId: "paused" },
					"README.md",
				),
			),
		).toEqual({ path: "README.md", text: "# Hi\n" });
		expect(isRunning).not.toHaveBeenCalled();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("lists a running machine with git and reads the asked-for file beside it", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-running-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, "a.ts"), "a");
		await writeFile(join(root, "untracked.ts"), "u");
		spawnSync("git", ["add", "a.ts"], { cwd: root });
		const machines = {
			isRunning: async () => true,
			readTextFile: async (_id: unknown, path: string) =>
				path === "/tmp/ytimesy-project-cwd"
					? `${root}\n`
					: readFile(path, "utf8").catch(() => null),
			exec: async (_id: unknown, command: string) => {
				const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
				return {
					exitCode: result.status ?? 1,
					stdout: result.stdout,
					stderr: result.stderr,
				};
			},
		} as unknown as WorkspaceMachines;
		const listing = await Effect.runPromise(
			listWorkspaceExplorer(
				machines,
				{ userId: "alice", projectId: "p1", sessionId: "running" },
				"untracked.ts",
			),
		);
		expect(listing.machine).toBeUndefined();
		expect([...listing.paths].sort()).toEqual(["a.ts", "untracked.ts"]);
		expect(listing.opened).toEqual({ path: "untracked.ts", text: "u" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("lists from the git index when a just-woken machine does not answer git", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-slow-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, "a.ts"), "a");
		spawnSync("git", ["add", "a.ts"], { cwd: root });
		const machines = {
			isRunning: async () => true,
			readTextFile: async (_id: unknown, path: string) =>
				path === "/tmp/ytimesy-project-cwd"
					? root
					: readFile(path, "utf8").catch(() => null),
			readFile: async (_id: unknown, path: string) => readFile(path),
			exec: async () => {
				throw new Error("guest did not answer");
			},
		} as unknown as WorkspaceMachines;
		const listing = await Effect.runPromise(
			listWorkspaceExplorer(machines, {
				userId: "alice",
				projectId: "p1",
				sessionId: "slow",
			}),
		);
		expect(listing).toMatchObject({
			paths: ["a.ts"],
			opened: { path: "a.ts", text: "a" },
		});
		expect(listing.machine).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("finds the checkout at its default path once a cold restart cleared /tmp", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-cold-"));
	try {
		spawnSync("git", ["init", "-q"], { cwd: root });
		await writeFile(join(root, "a.ts"), "a");
		spawnSync("git", ["add", "a.ts"], { cwd: root });
		// The project's repository is owner/repo, checked out at /home/ubuntu/repo.
		const onDisk = (path: string) =>
			path.startsWith("/home/ubuntu/repo/")
				? join(root, path.slice("/home/ubuntu/repo/".length))
				: null;
		const machines = {
			isRunning: async () => false,
			readTextFile: async (_id: unknown, path: string) => {
				const local = onDisk(path);
				return local ? readFile(local, "utf8").catch(() => null) : null;
			},
			readFile: async (_id: unknown, path: string) => {
				const local = onDisk(path);
				return local ? readFile(local).catch(() => null) : null;
			},
		} as unknown as WorkspaceMachines;
		expect(
			await Effect.runPromise(
				listWorkspaceExplorer(machines, {
					userId: "alice",
					projectId: "p1",
					sessionId: "cold",
				}),
			),
		).toMatchObject({
			root: "/home/ubuntu/repo",
			paths: ["a.ts"],
			opened: { path: "a.ts", text: "a" },
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("looks the chat up again when its remembered machine cannot read the file", async () => {
	const scope = { userId: "alice", projectId: "p1", sessionId: "moved" };
	const reads: string[] = [];
	let gone: string | undefined;
	const machines = {
		isRunning: async () => true,
		readTextFile: async (id: string, path: string) => {
			reads.push(`${id}:${path}`);
			if (path === "/tmp/ytimesy-project-cwd") return "/repo";
			// The first machine this chat had is gone.
			gone ??= id;
			return id === gone ? null : "now";
		},
	} as unknown as WorkspaceMachines;
	const read = () =>
		Effect.runPromise(readWorkspaceExplorerFile(machines, scope, "a.ts"));
	// Unreadable on a freshly looked-up machine: no second lookup.
	expect(await read()).toBeNull();
	// Unreadable on the remembered machine: looked up again, then read.
	expect(await read()).toEqual({ path: "a.ts", text: "now" });
	const machinesRead = reads
		.filter((entry) => entry.endsWith(":/repo/a.ts"))
		.map((entry) => entry.split(":")[0]);
	expect(machinesRead).toEqual([
		gone,
		gone,
		expect.not.stringMatching(gone ?? ""),
	]);
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

it("fails instead of reporting no changes when git diff fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-diff-failure-"));
	try {
		// No commit yet: there is no HEAD to diff against.
		spawnSync("git", ["-C", root, "init", "-q"]);
		await writeFile(join(root, "new.txt"), "new\n");
		const result = spawnSync("bash", ["-c", gitChangesScript(root, "")]);
		expect(result.status).not.toBe(0);
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

it("shows only the chat's own changes after its checkout fast-forwarded past an older snapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-fetched-"));
	try {
		const upstream = join(root, "upstream");
		const guest = join(root, "guest");
		const git = (directory: string, ...args: string[]) => {
			const result = spawnSync("git", [
				"-C",
				directory,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				...args,
			]);
			if (result.status !== 0) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		const receive = (mode: "clone" | "update") => {
			git(guest, "fetch", "-q", "--no-tags", upstream, "refs/heads/main");
			const result = spawnSync("bash", [
				"-c",
				`set -eu\n${fetchedBranchCommand({
					directory: guest,
					branch: "main",
					workingBranch: "main",
					mode,
					originUrl: "https://github.com/acme/app.git",
				})}`,
			]);
			if (result.status !== 0) throw new Error(result.stderr.toString());
		};
		await mkdir(upstream);
		git(upstream, "init", "-q", "-b", "main");
		await writeFile(join(upstream, "app.txt"), "v1\n");
		git(upstream, "add", ".");
		git(upstream, "commit", "-qm", "v1");
		await mkdir(guest);
		git(guest, "init", "-q");
		receive("clone");
		// The template snapshot is taken here; upstream then moves on.
		for (const name of ["one.txt", "two.txt", "three.txt"]) {
			await writeFile(join(upstream, name), `${name}\n`);
			git(upstream, "add", ".");
			git(upstream, "commit", "-qm", name);
		}
		const latest = git(upstream, "rev-parse", "HEAD");
		receive("update");
		expect(git(guest, "rev-parse", "refs/remotes/origin/main")).toBe(latest);
		expect(git(guest, "rev-parse", "HEAD")).toBe(latest);
		expect(git(guest, "rev-parse", "refs/ytimesy/base")).toBe(latest);
		await writeFile(join(guest, "app.txt"), "chat edit\n");
		const changes = spawnSync("bash", ["-c", gitChangesScript(guest, "main")]);
		expect(changes.status).toBe(0);
		expect(
			parseWorkspaceDiffOutput(changes.stdout.toString()).changes.map(
				(change) => change.path,
			),
		).toEqual(["app.txt"]);
		// A checkout with commits of its own keeps its base.
		git(guest, "commit", "-qam", "chat");
		receive("update");
		expect(git(guest, "rev-parse", "refs/ytimesy/base")).toBe(latest);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
