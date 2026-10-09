import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { apiAgentFileTools } from "./api-agent-file-tools";
import { apiAgentTools } from "./api-agent-tools";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function fixture(
	readOnly = false,
	nativePatch = false,
	beforeExec?: (command: string, root: string) => Promise<void>,
	replay = false,
	verifyBatch?: Parameters<typeof apiAgentFileTools>[0]["verifyBatch"],
) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-file-tools-"));
	roots.push(root);
	await run("git", ["init", "-q", root]);
	const commands: string[] = [];
	const machines = {
		exec: async (_vm: string, command: string) => {
			commands.push(command);
			await beforeExec?.(command, root);
			try {
				const result = await run("bash", [
					"-lc",
					command
						.replaceAll("/tmp/ytimesy-output-", `${root}/output-`)
						.replaceAll(
							"/tmp/ytimesy-environment.json",
							join(root, "environment-report.json"),
						),
				]);
				return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error) {
				const failed = error as Error & {
					code: number;
					stdout: string;
					stderr: string;
				};
				return {
					exitCode: failed.code,
					stdout: failed.stdout,
					stderr: failed.stderr,
				};
			}
		},
		writeTextFile: async (_vm: string, path: string, contents: string) =>
			writeFile(path, contents),
	} as unknown as WorkspaceMachines;
	const signal = new AbortController().signal;
	const receipts = new Map<string, unknown>();
	const tools = apiAgentFileTools({
		machines,
		vm: WorkspaceId("test-vm"),
		cwd: root,
		readOnly,
		nativePatch,
		signal,
		verifyBatch,
		once: async (id, execute) => {
			if (replay && receipts.has(id)) return receipts.get(id);
			const result = await execute();
			if (replay) receipts.set(id, result);
			return result;
		},
	});
	return { root, tools, commands, machines };
}

async function call(
	tool: unknown,
	input: object,
	messages: ModelMessage[] = [],
) {
	return (
		tool as { execute: (args: object, options: object) => Promise<unknown> }
	).execute(input, { toolCallId: "edit", messages });
}

it("wires the shared shell and command lifecycle into production writers, not read-only leads", async () => {
	const { root, machines } = await fixture();
	const input = {
		machines,
		cwd: root,
		session: {
			id: "shell-wiring-test",
			parentSessionId: "parent-test",
			userId: "owner",
			providerRef: "test-vm",
			taskAccess: "read_write",
		} as AgentSessionRecord,
		turnId: "shell-wiring-test",
		signal: new AbortController().signal,
	};
	const writer = apiAgentTools(input);
	for (const name of [
		"bash",
		"execute_command",
		"continue_command",
		"start_command",
		"wait_command",
		"read_command",
		"stop_command",
		"run_checks",
	])
		expect(writer[name]?.execute).toBeTypeOf("function");
	const lead = apiAgentTools({
		...input,
		session: { ...input.session, taskAccess: "read_only" },
	});
	for (const name of [
		"bash",
		"execute_command",
		"continue_command",
		"start_command",
		"wait_command",
		"stop_command",
		"run_checks",
	])
		expect(lead[name]).toBeUndefined();
	expect(lead.read_command.execute).toBeTypeOf("function");
	expect(
		apiAgentTools({
			...input,
			session: { ...input.session, parentSessionId: null },
		}).bash,
	).toBeUndefined();
});

it("reuses only freshly verified complete guidance reads and preserves explicit replay, changes and continuations", async () => {
	const { root, tools } = await fixture();
	const body = "Guidance 你\r\n".repeat(1800);
	await writeFile(join(root, "PLAN.md"), body);
	await writeFile(join(root, "source.ts"), body);
	const sha256 = createHash("sha256").update(body).digest("hex");
	const packet = (entry: object): ModelMessage[] => [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolName: "read_repository_guidance",
					toolCallId: "guide",
					output: {
						type: "json",
						value: { referencedDocuments: JSON.parse(JSON.stringify([entry])) },
					},
				},
			],
		},
	];
	const complete = { path: "PLAN.md", sha256, content: body, nextStart: null };
	const active = packet(complete);
	expect(await call(tools.read_file, { path: "PLAN.md" }, active)).toEqual({
		path: "PLAN.md",
		sha256,
		alreadyInContext: true,
		nextStart: null,
	});
	expect(
		await call(
			tools.read_file,
			{ path: "PLAN.md", repeatCompleteBody: true },
			active,
		),
	).toMatchObject({ content: body, start: 0, nextStart: null });
	expect(
		await call(tools.read_file, { path: "PLAN.md", start: 100 }, active),
	).toMatchObject({
		content: Array.from(body).slice(100).join(""),
		start: 100,
	});
	expect(
		await call(tools.read_file, { path: "source.ts" }, active),
	).toMatchObject({ content: body });
	expect(
		await call(
			tools.read_file,
			{ path: "PLAN.md" },
			packet({ ...complete, nextStart: 100 }),
		),
	).toMatchObject({ content: body });
	const archivedBody = {
		reference: "context-00000000-0000-4000-8000-000000000000",
		messageIndex: 1,
		toolCallId: "guide",
		characters: Array.from(body).length,
		instruction: "Recover exact archived text when needed.",
	};
	const archived = packet({
		path: "PLAN.md",
		sha256,
		nextStart: null,
		archivedBody,
	});
	expect(
		await call(tools.read_files, { paths: ["PLAN.md", "source.ts"] }, archived),
	).toMatchObject([
		{
			path: "PLAN.md",
			sha256,
			previouslyRead: true,
			archivedBody,
			nextStart: null,
		},
		{ path: "source.ts", content: body, truncated: false },
	]);
	expect(
		await call(
			tools.read_file,
			{ path: "PLAN.md", repeatCompleteBody: true },
			archived,
		),
	).toMatchObject({ content: body });
	await writeFile(join(root, "PLAN.md"), "Changed instructions");
	for (const history of [active, archived])
		expect(
			await call(tools.read_file, { path: "PLAN.md" }, history),
		).toMatchObject({ content: "Changed instructions" });
	expect(active).toEqual(packet(complete));
});

it("inspects staged, unstaged and untracked content without changing the index or reading ignored/symlink targets", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "tracked.ts"), "original\n");
	await writeFile(join(root, ".gitignore"), "ignored-secret\n");
	await run("git", ["-C", root, "add", "."]);
	await run("git", [
		"-C",
		root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	await writeFile(join(root, "tracked.ts"), "staged\n");
	await run("git", ["-C", root, "add", "tracked.ts"]);
	await writeFile(join(root, "tracked.ts"), "unstaged\n");
	await writeFile(join(root, "new [*] '$x;.ts"), "new source\n");
	await writeFile(join(root, "ignored-secret"), "SECRET_NOT_READ");
	const outside = await fixture();
	await writeFile(
		join(outside.root, "private.txt"),
		"EXTERNAL_SECRET_NOT_READ",
	);
	await symlink(join(outside.root, "private.txt"), join(root, "external-link"));
	await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
	const before = await readFile(join(root, ".git/index"));
	const result = await call(tools.inspect_changes, {});
	expect(result).toContain("+staged");
	expect(result).toContain("+unstaged");
	expect(result).toContain("+new source");
	expect(result).toContain("Binary files");
	expect(result).toContain("Untracked path not read");
	expect(result).not.toContain("SECRET_NOT_READ");
	expect(await readFile(join(root, ".git/index"))).toEqual(before);
	expect(
		await call(tools.inspect_changes, { path: "new [*] '$x;.ts" }),
	).toContain("+new source");
});

it("rejects traversal, absolute and git-internal inspection scopes before execution", async () => {
	const { tools, commands } = await fixture();
	for (const path of ["../outside", "/tmp", ".git/index", "a\\b", "a\0b"])
		await expect(call(tools.inspect_changes, { path })).rejects.toThrow();
	expect(commands).toEqual([]);
});

it("offers stat-only inspection without repeating source bodies or changing the index", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "new.txt"), "PRIVATE_SOURCE_BODY\n".repeat(2000));
	const result = await call(tools.inspect_changes, { view: "stat" });
	expect(result).toContain("new.txt");
	expect(result).toContain("2000 insertions");
	expect(result).not.toContain("PRIVATE_SOURCE_BODY");
	expect(String(result).length).toBeLessThan(500);
	await expect(readFile(join(root, ".git/index"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

it("does not advertise batch verification when its callback is unavailable", async () => {
	const { tools } = await fixture();
	expect(tools.apply_patches.description).not.toContain(
		"optional verification",
	);
	expect(tools.apply_patches.description).toContain("run_checks separately");
});

it("reports an unstaged move as a compact rename without changing the real index", async () => {
	const { root, tools } = await fixture();
	const body = `${Array.from(
		{ length: 727 },
		(_, i) => `export const value${i} = ${i};`,
	).join("\n")}\n`;
	await writeFile(join(root, "old.ts"), body);
	await run("git", ["-C", root, "add", "."]);
	await run("git", [
		"-C",
		root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-qm",
		"base",
	]);
	await rename(join(root, "old.ts"), join(root, "new.ts"));
	await writeFile(
		join(root, "new.ts"),
		body.replace("value0 = 0", "value0 = 1"),
	);
	const before = await readFile(join(root, ".git/index"));
	const result = await call(tools.inspect_changes, {});
	if (typeof result !== "string") throw new Error("Expected a complete diff");
	expect(result).toContain("rename from old.ts");
	expect(result).toContain("rename to new.ts");
	expect(result).toContain("+export const value0 = 1;");
	expect(result.length).toBeLessThan(1000);
	expect(await readFile(join(root, ".git/index"))).toEqual(before);
});

it("includes unborn repository changes without invoking clean/process filters or creating its real index", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, ".gitattributes"), "*.ts filter=guard\n");
	await writeFile(join(root, "new.ts"), "export const answer = 42;\n");
	await run("git", [
		"-C",
		root,
		"config",
		"filter.guard.clean",
		"touch filter-ran; cat",
	]);
	await run("git", ["-C", root, "config", "filter.guard.process", "exit 91"]);
	await run("git", ["-C", root, "config", "filter.guard.required", "true"]);
	expect(await call(tools.inspect_changes, {})).toContain(
		"+export const answer = 42;",
	);
	await expect(readFile(join(root, "filter-ran"))).rejects.toMatchObject({
		code: "ENOENT",
	});
	await expect(readFile(join(root, ".git/index"))).rejects.toMatchObject({
		code: "ENOENT",
	});
});

it("verifies only successfully completed batches and does not repeat writes or verification on replay", async () => {
	const verify = vi
		.fn()
		.mockResolvedValue({ checks: [{ exitCode: 0, stopped: null }] });
	const { tools, root } = await fixture(false, false, undefined, true, verify);
	const args = {
		operations: [{ type: "create_file", path: "new.txt", diff: "+ready" }],
		verification: {
			formatCommand: "format",
			commands: ["check"],
			maxSeconds: 120,
		},
	};
	const result = await call(tools.apply_patches, args);
	expect(await readFile(join(root, "new.txt"), "utf8")).toBe("ready");
	expect(verify).toHaveBeenCalledExactlyOnceWith(
		{ ...args.verification, parallelChecks: false, outputView: "summary" },
		"edit",
	);
	expect(await call(tools.apply_patches, args)).toEqual(result);
	expect(verify).toHaveBeenCalledTimes(1);
});

it("does not verify a partial batch or offer verification without a writable executor", async () => {
	const verify = vi.fn();
	const { tools, root } = await fixture(false, false, undefined, false, verify);
	await writeFile(join(root, "existing.txt"), "existing");
	await call(tools.apply_patches, {
		operations: [
			{ type: "create_file", path: "first.txt", diff: "+completed" },
			{ type: "create_file", path: "existing.txt", diff: "+replacement" },
		],
		verification: { commands: ["check"] },
	});
	expect(verify).not.toHaveBeenCalled();
	expect(await readFile(join(root, "first.txt"), "utf8")).toBe("completed");
	expect(
		(await fixture(true, false, undefined, false, verify)).tools.apply_patches,
	).toBeUndefined();
});

it("validates verification before writing and reports unavailable verification without effects", async () => {
	const verify = vi.fn();
	const { tools, commands } = await fixture(
		false,
		false,
		undefined,
		false,
		verify,
	);
	await expect(
		call(tools.apply_patches, {
			operations: [{ type: "create_file", path: "new.txt", diff: "+new" }],
			verification: { commands: [] },
		}),
	).rejects.toThrow();
	expect(commands).toEqual([]);
	expect(verify).not.toHaveBeenCalled();
	const unavailable = await fixture();
	await expect(
		call(unavailable.tools.apply_patches, {
			operations: [{ type: "create_file", path: "new.txt", diff: "+new" }],
			verification: { commands: ["check"] },
		}),
	).rejects.toThrow("unavailable");
	expect(unavailable.commands).toEqual([]);
});

it("prepares a coherent batch before writing and replays its completed receipt", async () => {
	const { root, tools, commands } = await fixture(
		false,
		false,
		undefined,
		true,
	);
	await writeFile(join(root, "existing.txt"), "before\n");
	const input = {
		operations: [
			{ type: "create_file", path: "new.txt", diff: "+created" },
			{
				type: "update_file",
				path: "existing.txt",
				diff: "@@\n-before\n+after",
			},
		],
	};
	const result = await call(tools.apply_patches, input);
	expect(result).toMatchObject({
		failedPath: null,
		unattemptedPaths: [],
		completed: [{ path: "new.txt" }, { path: "existing.txt" }],
	});
	expect(await readFile(join(root, "existing.txt"), "utf8")).toBe("after\n");
	expect(
		commands.filter((command) => command.includes("def apply_edit")),
	).toHaveLength(1);
	const count = commands.length;
	expect(await call(tools.apply_patches, input)).toEqual(result);
	expect(commands).toHaveLength(count);
});

it("checks each stale update inside the batch lock and preserves partial receipts", async () => {
	const { root, tools } = await fixture(false, false, async (command, root) => {
		if (command.includes("def apply_edit"))
			await writeFile(join(root, "existing.txt"), "concurrent edit\n");
	});
	await writeFile(join(root, "existing.txt"), "before\n");
	const result = await call(tools.apply_patches, {
		operations: [
			{ type: "create_file", path: "first.txt", diff: "+first" },
			{
				type: "update_file",
				path: "existing.txt",
				diff: "@@\n-before\n+after",
			},
			{ type: "create_file", path: "last.txt", diff: "+last" },
		],
	});
	expect(result).toMatchObject({
		completed: [{ path: "first.txt" }],
		failedPath: "existing.txt",
		unattemptedPaths: ["last.txt"],
	});
	expect(await readFile(join(root, "existing.txt"), "utf8")).toBe(
		"concurrent edit\n",
	);
	await expect(readFile(join(root, "last.txt"))).rejects.toThrow();
});

it("executes an eight-file create batch once while retaining diagnostics", async () => {
	const { tools, commands } = await fixture();
	const result = (await call(tools.apply_patches, {
		operations: Array.from({ length: 8 }, (_, index) => ({
			type: "create_file",
			path: `file-${index}.ts`,
			diff: "+const value: number = 1;",
		})),
	})) as { completed: unknown[] };
	expect(result.completed).toHaveLength(8);
	expect(
		commands.filter((command) => command.startsWith("python3 -c")),
	).toHaveLength(1);
	expect(
		commands.filter((command) => command.startsWith("rm -f")),
	).toHaveLength(1);
	expect(
		commands.filter((command) => command.includes('"onlyIfWarm":true')),
	).toHaveLength(1);
});

it("rejects invalid batch context before any file is written", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "existing.txt"), "before\n");
	await expect(
		call(tools.apply_patches, {
			operations: [
				{ type: "create_file", path: "new.txt", diff: "+created" },
				{
					type: "update_file",
					path: "existing.txt",
					diff: "@@\n-missing\n+after",
				},
			],
		}),
	).rejects.toThrow();
	await expect(readFile(join(root, "new.txt"))).rejects.toThrow();
});

it("reports partial writes truthfully and never retries a completed batch receipt", async () => {
	const { root, tools, commands } = await fixture(
		false,
		false,
		undefined,
		true,
	);
	await writeFile(join(root, "exists.txt"), "preserved");
	const input = {
		operations: [
			{ type: "create_file", path: "first.txt", diff: "+first" },
			{ type: "create_file", path: "exists.txt", diff: "+overwrite" },
			{ type: "create_file", path: "last.txt", diff: "+last" },
		],
	};
	const result = await call(tools.apply_patches, input);
	expect(result).toMatchObject({
		completed: [{ path: "first.txt" }],
		failedPath: "exists.txt",
		unattemptedPaths: ["last.txt"],
	});
	expect(await readFile(join(root, "exists.txt"), "utf8")).toBe("preserved");
	await expect(readFile(join(root, "last.txt"))).rejects.toThrow();
	const count = commands.length;
	expect(await call(tools.apply_patches, input)).toEqual(result);
	expect(commands).toHaveLength(count);
});

it.each(["../escape", "/absolute", ".git/config", "same.txt"])(
	"rejects unsafe or repeated batch path %s before guest execution",
	async (path) => {
		const { tools, commands } = await fixture();
		await expect(
			call(tools.apply_patches, {
				operations: [
					{ type: "create_file", path: "same.txt", diff: "+first" },
					{ type: "create_file", path, diff: "+second" },
				],
			}),
		).rejects.toThrow();
		expect(commands).toHaveLength(0);
	},
);

it("creates and precisely replaces a file without overwriting an existing one", async () => {
	const { root, tools } = await fixture();
	await call(tools.create_file, {
		path: "src/example.ts",
		content: "const value = 1;\n",
	});
	await expect(
		call(tools.create_file, { path: "src/example.ts", content: "overwrite" }),
	).rejects.toThrow();
	await call(tools.replace_text, {
		path: "src/example.ts",
		old: "value = 1",
		new: "value = 2",
	});
	expect(await readFile(join(root, "src/example.ts"), "utf8")).toBe(
		"const value = 2;\n",
	);
});

it("rejects git metadata reached through a parent-directory symlink", async () => {
	const { root, tools } = await fixture();
	await symlink(".git", join(root, "metadata"));
	const original = await readFile(join(root, ".git/config"), "utf8");
	await expect(
		call(tools.replace_text, {
			path: "metadata/config",
			old: "[core]",
			new: "[unsafe]",
		}),
	).rejects.toThrow(".git");
	await expect(
		call(tools.create_file, {
			path: "metadata/injected",
			content: "forbidden",
		}),
	).rejects.toThrow(".git");
	expect(await readFile(join(root, ".git/config"), "utf8")).toBe(original);
	await expect(readFile(join(root, ".git/injected"))).rejects.toThrow();
});

it("returns available batch files alongside explicit missing-path errors without guessing empty contents", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "present.txt"), "present source");
	expect(
		await call(tools.read_files, { paths: ["missing.txt", "present.txt"] }),
	).toMatchObject([
		{ path: "missing.txt", error: "not-a-file" },
		{ path: "present.txt", content: "present source", truncated: false },
	]);
	await expect(
		call(tools.read_file, { path: "missing.txt" }),
	).rejects.toThrow();
	await expect(
		call(tools.read_files, { paths: ["present.txt", ".git/config"] }),
	).rejects.toThrow();
});

it("searches all matches in tracked and nonignored untracked files without executing query text", async () => {
	const { root, machines } = await fixture();
	const tools = apiAgentTools({
		machines,
		cwd: root,
		session: {
			id: "search-test",
			userId: "owner",
			providerRef: "test-vm",
			taskAccess: "read_only",
		} as AgentSessionRecord,
		turnId: "search-test",
		signal: new AbortController().signal,
	});
	await writeFile(join(root, "tracked.txt"), "needle\n".repeat(8));
	await run("git", ["-C", root, "add", "tracked.txt"]);
	await writeFile(join(root, "new.txt"), "needle\n");
	await writeFile(join(root, ".gitignore"), "ignored.txt\n");
	await writeFile(join(root, "ignored.txt"), "needle\n");
	const result = (await call(tools.search_files, {
		query: "needle",
		literal: true,
	})) as { stdout: string; exitCode: number };
	expect(result.exitCode).toBe(0);
	expect(result.stdout.match(/tracked.txt:/g)).toHaveLength(8);
	expect(result.stdout).toContain("new.txt:1:needle");
	expect(result.stdout).not.toContain("ignored.txt");
	const injected = (await call(tools.search_files, {
		query: "'; touch ATTACK; echo '",
		literal: true,
	})) as { exitCode: number };
	expect(injected.exitCode).toBe(1);
	await expect(readFile(join(root, "ATTACK"))).rejects.toThrow();
});

it("rejects a patch when another edit changes the inspected source before its atomic write", async () => {
	const { root, tools } = await fixture(false, false, async (command, cwd) => {
		if (command.includes("fcntl"))
			await writeFile(join(cwd, "race.txt"), "new owner value");
	});
	await writeFile(join(root, "race.txt"), "old");
	await expect(
		call(tools.apply_patch, {
			operation: {
				type: "update_file",
				path: "race.txt",
				diff: "@@\n-old\n+replacement",
			},
		}),
	).rejects.toThrow();
	expect(await readFile(join(root, "race.txt"), "utf8")).toBe(
		"new owner value",
	);
});

it("replays a completed delete receipt without reading or deleting the now-missing file again", async () => {
	const { root, tools, commands } = await fixture(
		false,
		false,
		undefined,
		true,
	);
	await writeFile(join(root, "delete.txt"), "value");
	const input = { operation: { type: "delete_file", path: "delete.txt" } };
	const result = await call(tools.apply_patch, input);
	const count = commands.length;
	expect(await call(tools.apply_patch, input)).toEqual(result);
	expect(commands).toHaveLength(count);
	await expect(readFile(join(root, "delete.txt"))).rejects.toThrow();
});

it("applies maintained V4A create/update/delete operations and rejects bad context", async () => {
	const { root, tools } = await fixture();
	await call(tools.apply_patch, {
		operation: {
			type: "create_file",
			path: "patch.txt",
			diff: "+first\n+second",
		},
	});
	expect(await readFile(join(root, "patch.txt"), "utf8")).toBe("first\nsecond");
	await call(tools.apply_patch, {
		operation: {
			type: "update_file",
			path: "patch.txt",
			diff: "@@\n first\n-second\n+changed",
		},
	});
	expect(await readFile(join(root, "patch.txt"), "utf8")).toBe(
		"first\nchanged",
	);
	await expect(
		call(tools.apply_patch, {
			operation: {
				type: "update_file",
				path: "patch.txt",
				diff: "@@\n-missing\n+bad",
			},
		}),
	).rejects.toThrow();
	await call(tools.apply_patch, {
		operation: { type: "delete_file", path: "patch.txt" },
	});
	await expect(readFile(join(root, "patch.txt"))).rejects.toThrow();
});

it.each([
	["+first\n+second\n", "first\nsecond\n"],
	["+first\n+\n", "first\n\n"],
	["+first\r\n+second\r\n", "first\nsecond\n"],
	["+first\n+second", "first\nsecond"],
])(
	"preserves explicit final newlines in create diffs %j",
	async (diff, expected) => {
		const { root, tools } = await fixture();
		await call(tools.apply_patches, {
			operations: [{ type: "create_file", path: "created.txt", diff }],
		});
		expect(await readFile(join(root, "created.txt"), "utf8")).toBe(expected);
	},
);

it("never grants patch writes to the read-only leader", async () => {
	const { tools } = await fixture(true);
	expect(tools.apply_patch).toBeUndefined();
});

it("uses the maintained OpenAI native tool contract for Responses transports", async () => {
	const { root, tools } = await fixture(false, true);
	expect(tools.apply_patch.type).toBe("provider");
	const result = await call(tools.apply_patch, {
		callId: "patch",
		operation: {
			type: "create_file",
			path: "native.ts",
			diff: "+export const value = 1;",
		},
	});
	expect(result).toMatchObject({
		status: "completed",
		output: expect.any(String),
	});
	expect(await readFile(join(root, "native.ts"), "utf8")).toBe(
		"export const value = 1;",
	);
	expect(
		await call(tools.apply_patch, {
			callId: "bad",
			operation: {
				type: "update_file",
				path: "native.ts",
				diff: "@@\n-missing\n+bad",
			},
		}),
	).toMatchObject({ status: "failed", output: expect.any(String) });
});

it("preserves CRLF content when a maintained patch updates an existing file", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "crlf.txt"), "first\r\nsecond\r\n");
	await call(tools.apply_patch, {
		operation: {
			type: "update_file",
			path: "crlf.txt",
			diff: "@@\n first\n-second\n+changed",
		},
	});
	expect(await readFile(join(root, "crlf.txt"), "utf8")).toBe(
		"first\r\nchanged\r\n",
	);
});

it("rejects patch path escapes, symlink targets and ambiguous context without altering data", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "source.txt"), "untouched");
	await symlink("source.txt", join(root, "link.txt"));
	for (const path of ["../outside.txt", ".git/config", "link.txt"]) {
		await expect(
			call(tools.apply_patch, { operation: { type: "delete_file", path } }),
		).rejects.toThrow();
	}
	expect(await readFile(join(root, "source.txt"), "utf8")).toBe("untouched");
});

it("rejects paths outside the repository and ambiguous edits", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "same.txt"), "same same");
	await expect(
		call(tools.create_file, { path: "../outside.txt", content: "bad" }),
	).rejects.toThrow();
	await expect(
		call(tools.replace_text, { path: "same.txt", old: "same", new: "new" }),
	).rejects.toThrow();
	expect(await readFile(join(root, "same.txt"), "utf8")).toBe("same same");
});

it("does not edit through a symlink", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "target.txt"), "original");
	await symlink("target.txt", join(root, "link.txt"));
	await expect(
		call(tools.replace_text, {
			path: "link.txt",
			old: "original",
			new: "changed",
		}),
	).rejects.toThrow();
	expect(await readFile(join(root, "target.txt"), "utf8")).toBe("original");
});

it("only offers inspection to a read-only lead", async () => {
	const { tools } = await fixture(true);
	expect(Object.keys(tools)).toEqual([
		"view_image",
		"read_environment_report",
		"read_files",
		"read_file",
		"inspect_changes",
		"verify_changes",
		"read_code",
	]);
});

it("reports absent setup metadata without a failed read or arbitrary path access", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "other.txt"), "not the report");
	expect(
		await call(tools.read_environment_report, { start: 0, path: "other.txt" }),
	).toEqual({ available: false });
});

it("reads setup metadata in bounded Unicode-preserving pages", async () => {
	const { root, tools } = await fixture(true);
	const text = `${"你".repeat(32_000)}baseline check failed: exit 2`;
	await writeFile(join(root, "environment-report.json"), text);
	expect(await call(tools.read_environment_report, { start: 0 })).toEqual({
		available: true,
		start: 0,
		text: text.slice(0, 32_000),
		nextStart: 32_000,
	});
	expect(await call(tools.read_environment_report, { start: 32_000 })).toEqual({
		available: true,
		start: 32_000,
		text: text.slice(32_000),
		nextStart: null,
	});
});

it("rejects a symlink in place of the prepared report", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "private.txt"), "private");
	await symlink("private.txt", join(root, "environment-report.json"));
	await expect(
		call(tools.read_environment_report, { start: 0 }),
	).rejects.toThrow("safely read");
});

it("reads several known files in order without writing to the repository", async () => {
	const { root, tools, commands } = await fixture(true);
	await writeFile(join(root, "first.txt"), "first\n");
	await writeFile(join(root, "second's.txt"), "second 你好\n");
	expect(
		await call(tools.read_files, { paths: ["second's.txt", "first.txt"] }),
	).toMatchObject([
		{ path: "second's.txt", content: "second 你好\n", truncated: false },
		{ path: "first.txt", content: "first\n", truncated: false },
	]);
	expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
	expect(commands).toHaveLength(1);
});

it("reads complete files through bounded pages without silently truncating instructions", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(
		join(root, "large.txt"),
		`${"你".repeat(32_000)}remaining instructions`,
	);
	expect(await call(tools.read_file, { path: "large.txt" })).toMatchObject({
		path: "large.txt",
		start: 0,
		content: "你".repeat(32_000),
		nextStart: 32_000,
	});
	expect(
		await call(tools.read_file, { path: "large.txt", start: 32_000 }),
	).toMatchObject({
		path: "large.txt",
		start: 32_000,
		content: "remaining instructions",
		nextStart: null,
	});
	for (const start of [-1, 10_000_001, 0.5])
		await expect(
			call(tools.read_file, { path: "large.txt", start }),
		).rejects.toThrow();
	await expect(
		call(tools.read_file, { path: ".git/config" }),
	).rejects.toThrow();
});

it("reads large required documents and skills together in one bounded call", async () => {
	const { root, tools, commands } = await fixture(true);
	const plan = "你😀abc\n".repeat(15000);
	const skill = "Complete skill instructions\n";
	await writeFile(join(root, "PLAN.md"), plan);
	await writeFile(join(root, "SKILL.md"), skill);
	const rows = await call(tools.read_files, {
		paths: ["PLAN.md", "SKILL.md"],
		maxCharacters: 128000,
	});
	expect(rows).toMatchObject([
		{ path: "PLAN.md", content: plan, truncated: false },
		{ path: "SKILL.md", content: skill, truncated: false },
	]);
	expect(commands).toHaveLength(1);
});

it("preserves continuation offsets when an explicitly larger page is still incomplete", async () => {
	const { root, tools } = await fixture(true);
	const text = "你".repeat(128005);
	await writeFile(join(root, "PLAN.md"), text);
	expect(
		await call(tools.read_file, { path: "PLAN.md", maxCharacters: 128000 }),
	).toMatchObject({
		path: "PLAN.md",
		start: 0,
		content: text.slice(0, 128000),
		nextStart: 128000,
	});
	expect(
		await call(tools.read_file, {
			path: "PLAN.md",
			start: 128000,
			maxCharacters: 128000,
		}),
	).toMatchObject({
		path: "PLAN.md",
		start: 128000,
		content: text.slice(128000),
		nextStart: null,
	});
	await expect(
		call(tools.read_file, { path: "PLAN.md", maxCharacters: 128001 }),
	).rejects.toThrow();
});

it("bounds each file and the complete multi-file response, with explicit truncation", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "large.txt"), "x".repeat(40_000));
	const rows = (await call(tools.read_files, {
		paths: ["large.txt", "large.txt", "large.txt"],
	})) as { content: string; truncated: boolean }[];
	expect(rows.map((row) => row.content.length)).toEqual([32_000, 32_000, 0]);
	expect(rows.every((row) => row.truncated)).toBe(true);
});

it("rejects traversal, absolute paths, .git reads, and escaping symlinks", async () => {
	const { root, tools } = await fixture(true);
	const external = await fixture(true);
	await writeFile(join(external.root, "other.txt"), "private outside content");
	await symlink(external.root, join(root, "outside"));
	await symlink(".git", join(root, "metadata"));
	for (const path of [
		"../outside.txt",
		join(root, "inside.txt"),
		".git/config",
		"metadata/config",
		"outside/other.txt",
		join(external.root, "other.txt"),
	]) {
		await expect(call(tools.read_files, { paths: [path] })).rejects.toThrow();
	}
});

it("enforces the file-count bound even when invoked without schema validation", async () => {
	const { tools } = await fixture(true);
	for (const paths of [[], Array(9).fill("same.txt")]) {
		await expect(call(tools.read_files, { paths })).rejects.toThrow();
	}
});

it("labels unavailable batch files explicitly rather than dropping known source", async () => {
	const { root, tools } = await fixture(true);
	await writeFile(join(root, "present.txt"), "present");
	expect(
		await call(tools.read_files, { paths: ["present.txt", "missing.txt"] }),
	).toMatchObject([
		{ path: "present.txt", content: "present", truncated: false },
		{ path: "missing.txt", error: "not-a-file" },
	]);
});

it("reports diff-check failures without claiming a clean verification", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "tracked.txt"), "clean\n");
	await run("git", ["-C", root, "add", "tracked.txt"]);
	await writeFile(join(root, "tracked.txt"), "trailing space  \n");
	const result = (await call(tools.verify_changes, {})) as { passed: boolean };
	expect(result.passed).toBe(false);
});

it("also checks staged changes and inspects a repository without a commit", async () => {
	const { root, tools } = await fixture();
	await writeFile(join(root, "staged.txt"), "trailing space  \n");
	await run("git", ["-C", root, "add", "staged.txt"]);
	const inspection = (await call(tools.inspect_changes, {})) as string;
	expect(inspection).toContain("staged.txt");
	const result = (await call(tools.verify_changes, {})) as { passed: boolean };
	expect(result.passed).toBe(false);
});
