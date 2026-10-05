import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({ session: vi.fn(), workspace: vi.fn() }));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
}));
vi.mock("./api-turn-workspace", () => ({
	deferredApiTurnWorkspace: () => mocks.workspace,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (m: unknown) => m,
}));

import {
	captureTaskPatch,
	importReviewedTaskChanges,
} from "./reviewed-task-import";

const run = promisify(execFile);
const roots: string[] = [];
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-reviewed-import-"));
	roots.push(root);
	const sourcePath = join(root, "source"),
		destinationPath = join(root, "destination");
	const git = (directory: string, ...args: string[]) =>
		run("git", ["-C", directory, ...args]);
	await run("git", ["init", "-q", sourcePath]);
	await writeFile(join(sourcePath, "existing.txt"), "before\n");
	await writeFile(join(sourcePath, "deleted.txt"), "delete me\n");
	await git(sourcePath, "add", ".");
	await git(
		sourcePath,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"base",
	);
	await run("git", ["clone", "-q", sourcePath, destinationPath]);
	await writeFile(join(sourcePath, "existing.txt"), "after\n");
	await git(sourcePath, "add", "existing.txt");
	await rm(join(sourcePath, "deleted.txt"));
	await writeFile(join(sourcePath, "new file.txt"), "你好\n");
	await writeFile(
		join(sourcePath, "binary.dat"),
		Buffer.from([0, 255, 128, 1]),
	);
	const source = {
		id: "source",
		userId: "owner",
		projectId: "project",
		parentSessionId: "lead",
		candidateIndex: null,
		taskAccess: "read_write",
		taskPlacement: "fresh",
		taskState: "done",
		taskReviewState: "reviewed",
		providerRef: "source-vm",
	} as AgentSessionRecord;
	const destination = {
		...source,
		id: "destination",
		taskState: "working",
		taskReviewState: "pending",
		providerRef: "destination-vm",
	} as AgentSessionRecord;
	const writes: string[] = [];
	const commands: string[] = [];
	const machines = {
		exec: async (vm: string, command: string) => {
			commands.push(command);
			const actual = command.replace(
				'"$(cat /tmp/ytimesy-project-cwd)"',
				`'${vm === "source-vm" ? sourcePath : destinationPath}'`,
			);
			try {
				const r = await run("sh", ["-c", actual]);
				return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
			} catch (e) {
				const r = e as { code: number; stdout: string; stderr: string };
				return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
			}
		},
		writeTextFile: async (_vm: string, path: string, text: string) => {
			writes.push(path);
			await writeFile(path, text);
		},
	} as unknown as WorkspaceMachines;
	mocks.session.mockResolvedValue(source);
	mocks.workspace.mockResolvedValue({
		machines,
		vm: WorkspaceId("destination-vm"),
		cwd: destinationPath,
	});
	const { sha256 } = await captureTaskPatch(machines, WorkspaceId("source-vm"));
	commands.length = 0;
	return {
		sha256,
		source,
		destination,
		machines,
		writes,
		commands,
		sourcePath,
		destinationPath,
		git,
	};
}

it("imports exact staged, unstaged, untracked and binary changes without changing source index or creating commits", async () => {
	const f = await fixture();
	const index = await readFile(join(f.sourcePath, ".git/index"));
	const before = (await f.git(f.destinationPath, "rev-parse", "HEAD")).stdout;
	const result = await importReviewedTaskChanges(
		f.machines,
		f.destination,
		"source",
		f.sha256,
	);
	expect(result.status).toBe("imported");
	expect(result.verificationRequired).toBe(true);
	expect(await readFile(join(f.sourcePath, ".git/index"))).toEqual(index);
	expect((await f.git(f.destinationPath, "rev-parse", "HEAD")).stdout).toBe(
		before,
	);
	expect(await readFile(join(f.destinationPath, "existing.txt"), "utf8")).toBe(
		"after\n",
	);
	expect(await readFile(join(f.destinationPath, "new file.txt"), "utf8")).toBe(
		"你好\n",
	);
	expect(await readFile(join(f.destinationPath, "binary.dat"))).toEqual(
		Buffer.from([0, 255, 128, 1]),
	);
	await expect(
		readFile(join(f.destinationPath, "deleted.txt")),
	).rejects.toThrow();
	for (const path of f.writes) await expect(readFile(path)).rejects.toThrow();
});

it("rejects a conflict atomically and preserves unrelated destination edits", async () => {
	const f = await fixture();
	await writeFile(
		join(f.destinationPath, "existing.txt"),
		"my uncommitted work\n",
	);
	await expect(
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
	).rejects.toThrow("conflicts");
	expect(await readFile(join(f.destinationPath, "existing.txt"), "utf8")).toBe(
		"my uncommitted work\n",
	);
	expect(await readFile(join(f.destinationPath, "deleted.txt"), "utf8")).toBe(
		"delete me\n",
	);
	await expect(
		readFile(join(f.destinationPath, "new file.txt")),
	).rejects.toThrow();
});

it("rejects a different base before applying any files", async () => {
	const f = await fixture();
	await f.git(
		f.destinationPath,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--allow-empty",
		"-qm",
		"new base",
	);
	await expect(
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
	).rejects.toThrow("base differs");
	expect(await readFile(join(f.destinationPath, "existing.txt"), "utf8")).toBe(
		"before\n",
	);
});

it("serializes overlapping imports and refuses to overwrite the first result", async () => {
	const f = await fixture();
	const results = await Promise.allSettled([
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === "rejected")).toHaveLength(
		1,
	);
	expect(await readFile(join(f.destinationPath, "existing.txt"), "utf8")).toBe(
		"after\n",
	);
});

it.each([
	["owner", { userId: "other" }],
	["project", { projectId: "other" }],
	["group", { parentSessionId: "other" }],
	["active", { taskState: "working" }],
	["unreviewed", { taskReviewState: "pending" }],
	["candidate", { candidateIndex: 0 }],
	["shared", { taskPlacement: "shared" }],
	["self", { id: "destination" }],
])(
	"rejects an unauthorized %s source before accessing a VM",
	async (_name, change) => {
		const f = await fixture();
		mocks.session.mockResolvedValue({ ...f.source, ...change });
		await expect(
			importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
		).rejects.toThrow("reviewed writable sibling");
		expect(f.commands).toHaveLength(0);
	},
);

it("does not grant write access to a lead or shared reader", async () => {
	const f = await fixture();
	await expect(
		importReviewedTaskChanges(
			f.machines,
			{ ...f.destination, taskAccess: "read_only" },
			"source",
			f.sha256,
		),
	).rejects.toThrow("fresh writable builder");
	expect(f.commands).toHaveLength(0);
});

it("rechecks review after export before resolving the destination", async () => {
	const f = await fixture();
	mocks.session
		.mockResolvedValueOnce(f.source)
		.mockResolvedValueOnce({ ...f.source, taskReviewState: "pending" });
	await expect(
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
	).rejects.toThrow("reviewed writable sibling");
	expect(mocks.workspace).not.toHaveBeenCalled();
	expect(f.writes).toHaveLength(0);
});

it("rejects edits made after the parent's exact patch inspection", async () => {
	const f = await fixture();
	await writeFile(join(f.sourcePath, "new file.txt"), "changed after review\n");
	await expect(
		importReviewedTaskChanges(f.machines, f.destination, "source", f.sha256),
	).rejects.toThrow("differ from the inspected patch");
	expect(mocks.workspace).not.toHaveBeenCalled();
	expect(f.writes).toHaveLength(0);
});

it("does not apply a patch through a destination symlink outside the checkout", async () => {
	const f = await fixture();
	const outside = join(f.sourcePath, "..", "outside");
	await mkdir(outside);
	await mkdir(join(f.sourcePath, "sub"));
	await writeFile(join(f.sourcePath, "sub", "file.txt"), "must stay inside\n");
	await symlink(outside, join(f.destinationPath, "sub"));
	const { sha256 } = await captureTaskPatch(
		f.machines,
		WorkspaceId("source-vm"),
	);
	await expect(
		importReviewedTaskChanges(f.machines, f.destination, "source", sha256),
	).rejects.toThrow("conflicts");
	await expect(readFile(join(outside, "file.txt"))).rejects.toThrow();
	expect(await readFile(join(f.destinationPath, "existing.txt"), "utf8")).toBe(
		"before\n",
	);
});
