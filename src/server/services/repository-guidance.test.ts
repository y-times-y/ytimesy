import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ModelMessage } from "ai";
import { afterEach, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { localHarnessWorkspace } from "../../../tests/helpers/local-harness-workspace";
import {
	inspectRepositoryGuidance,
	RepositoryGuidanceUnavailable,
	repositoryGuidanceTool,
} from "./repository-guidance";
import { readRepositoryInstructions } from "./repository-instructions";
import type { WorkspaceMachines } from "./workspace-machines";

const run = promisify(execFile);
const roots: string[] = [];
const locked: string[] = [];
afterEach(async () => {
	await Promise.all(locked.splice(0).map((path) => chmod(path, 0o755)));
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

it("reuses complete matching instructions but discovers new scoped rules and changed bodies", async () => {
	const { root, read } = await fixture();
	await writeFile(
		join(root, "AGENTS.md"),
		"Read [plan](PLAN.md). Root policy.",
	);
	await writeFile(join(root, "PLAN.md"), "Required plan");
	await mkdir(join(root, "src"));
	await writeFile(join(root, "src", "AGENTS.md"), "Scoped policy");
	const first = await read(".");
	const history: ModelMessage[] = [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "initial",
					toolName: "read_repository_guidance",
					output: { type: "json", value: JSON.parse(JSON.stringify(first)) },
				},
			],
		},
	];
	const scoped = await read("src", history);
	expect(scoped.instructions[0]).toMatchObject({ alreadyInContext: true });
	expect(scoped.instructions[0].content).toBeUndefined();
	expect(scoped.instructions[1].content).toBe("Scoped policy");
	expect(scoped.referencedDocuments[0]).toMatchObject({
		alreadyInContext: true,
	});
	await writeFile(join(root, "AGENTS.md"), "Changed root policy");
	expect((await read("src", history)).instructions[0].content).toBe(
		"Changed root policy",
	);
	expect((await read(".")).instructions[0].content).toBe("Changed root policy");
});

it("verifies archived complete reads without replaying unchanged bodies or claiming they are in context", async () => {
	const { root, read } = await fixture();
	await writeFile(join(root, "AGENTS.md"), "Read [plan](PLAN.md).");
	await writeFile(join(root, "PLAN.md"), "Original instructions ".repeat(1000));
	const first = await read(".");
	const document = first.referencedDocuments[0];
	const archivedBody = {
		reference: "context-00000000-0000-4000-8000-000000000000",
		messageIndex: 1,
		toolCallId: "original-read",
		characters: document.content?.length ?? 0,
		instruction: "Recover the exact original when a detail is forgotten.",
	};
	const history: ModelMessage[] = [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolName: "read_repository_guidance",
					toolCallId: "earlier",
					output: {
						type: "json",
						value: {
							referencedDocuments: [
								{
									path: document.path,
									sha256: document.sha256,
									nextStart: null,
									archivedBody,
								},
							],
						},
					},
				},
			],
		},
	];
	const current = (await read(".", history)).referencedDocuments[0];
	expect(current).toMatchObject({
		previouslyRead: true,
		archivedBody,
		nextStart: null,
	});
	expect(current.content).toBeUndefined();
	expect(current.alreadyInContext).toBeUndefined();
	const invalidHistory = JSON.parse(JSON.stringify(history)) as ModelMessage[];
	const part = invalidHistory[0];
	if (
		part.role === "tool" &&
		part.content[0].type === "tool-result" &&
		part.content[0].output.type === "json"
	) {
		part.content[0].output.value = {
			referencedDocuments: [
				{
					path: document.path,
					sha256: document.sha256,
					nextStart: 100,
					archivedBody,
				},
			],
		};
	}
	expect((await read(".", invalidHistory)).referencedDocuments[0].content).toBe(
		document.content,
	);
	await writeFile(join(root, "PLAN.md"), "Changed instructions");
	expect((await read(".", history)).referencedDocuments[0]).toMatchObject({
		content: "Changed instructions",
		nextStart: null,
	});
});

it("prefetches bounded root configuration with exact hashes and no secrets or symlink targets", async () => {
	const { root, read } = await fixture();
	await writeFile(
		join(root, "package.json"),
		'{"scripts":{"test":"vitest run"}}',
	);
	await writeFile(join(root, "biome.json"), "你".repeat(20000));
	await writeFile(join(root, "tsconfig.json"), "界".repeat(20000));
	await writeFile(join(root, ".env"), "SECRET_SHOULD_NOT_APPEAR");
	await symlink(".env", join(root, "vitest.config.ts"));
	const first = await read(".");
	expect(first.configuration.map((item) => item.path)).toEqual([
		"package.json",
		"biome.json",
		"tsconfig.json",
	]);
	expect(first.configuration[0]).toMatchObject({
		content: '{"scripts":{"test":"vitest run"}}',
		sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		nextStart: null,
	});
	expect(first.configuration[1]).toMatchObject({
		content: "你".repeat(16000),
		nextStart: 16000,
	});
	expect(
		first.configuration.reduce(
			(sum, item) => sum + (item.content?.length ?? 0),
			0,
		),
	).toBe(32000);
	expect(JSON.stringify(first)).not.toContain("SECRET_SHOULD_NOT_APPEAR");
	const history: ModelMessage[] = [
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "earlier",
					toolName: "read_repository_guidance",
					output: { type: "json", value: JSON.parse(JSON.stringify(first)) },
				},
			],
		},
	];
	expect((await read(".", history)).configuration[0]).toMatchObject({
		alreadyInContext: true,
	});
	expect((await read(".", history)).configuration[1].content).toBeDefined();
	await writeFile(join(root, "package.json"), "Changed configuration");
	expect((await read(".", history)).configuration[0].content).toBe(
		"Changed configuration",
	);
	expect((await read(".")).configuration[0].content).toBe(
		"Changed configuration",
	);
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-guidance-"));
	roots.push(root);
	await run("git", ["init", "-q", root]);
	const machines = {
		exec: async (_vm: string, command: string) => {
			try {
				return { ...(await run("bash", ["-lc", command])), exitCode: 0 };
			} catch {
				return { exitCode: 1, stdout: "", stderr: "" };
			}
		},
	} as unknown as WorkspaceMachines;
	const tool = repositoryGuidanceTool({
		machines,
		vm: WorkspaceId("test"),
		cwd: root,
		signal: new AbortController().signal,
	});
	return {
		root,
		read: async (scope: string, messages: ModelMessage[] = []) => {
			const result = await tool.execute?.(
				{ scope },
				{ toolCallId: "guidance", messages, context: {} },
			);
			if (!result || !("instructions" in result))
				throw new Error("Expected a completed guidance packet");
			return result;
		},
	};
}

it("includes bounded scoped source paths without hidden files or escaping symlinks", async () => {
	const { root, read } = await fixture();
	await mkdir(join(root, "src/domain"), { recursive: true });
	await mkdir(join(root, "elsewhere"));
	await writeFile(join(root, "elsewhere/private.ts"), "outside scope");
	await writeFile(join(root, "src/domain/.env"), "private");
	await symlink(
		"../../elsewhere/private.ts",
		join(root, "src/domain/alias.ts"),
	);
	for (let index = 0; index < 205; index++)
		await writeFile(
			join(root, `src/domain/source-${String(index).padStart(3, "0")}.ts`),
			"source",
		);
	const packet = await read("src/domain/new-module.ts");
	expect(packet.scopeFiles).toHaveLength(200);
	expect(packet.scopeFilesTruncated).toBe(true);
	expect(packet.scopeFiles[0]).toBe("src/domain/source-000.ts");
	expect(packet.scopeFiles).not.toContain("src/domain/alias.ts");
	expect(packet.scopeFiles).not.toContain("src/domain/.env");
	expect(packet.scopeFiles).not.toContain("elsewhere/private.ts");
	expect(packet.scopeFiles.join("").length).toBeLessThanOrEqual(8000);
});

it("bounds inventory characters independently of the file count", async () => {
	const { root, read } = await fixture();
	const folder = "d".repeat(200);
	await mkdir(join(root, folder));
	for (let index = 0; index < 50; index++)
		await writeFile(join(root, folder, `${index}.ts`), "source");
	const packet = await read(folder);
	expect(packet.scopeFiles.length).toBeGreaterThan(0);
	expect(packet.scopeFiles.length).toBeLessThan(50);
	expect(packet.scopeFilesTruncated).toBe(true);
	expect(packet.scopeFiles.join("").length).toBeLessThanOrEqual(8000);
});

it("loads only applicable ancestor instructions and defers skill bodies", async () => {
	const { root, read } = await fixture();
	await mkdir(join(root, "src"));
	await mkdir(join(root, "other"));
	await mkdir(join(root, ".agents/skills/checks"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), "Root instructions");
	await writeFile(join(root, "src/AGENTS.md"), "Nested instructions");
	await writeFile(join(root, "src/file.ts"), "export const value = 1;");
	await writeFile(join(root, "other/AGENTS.md"), "Not applicable");
	await writeFile(
		join(root, ".agents/skills/checks/SKILL.md"),
		"---\nname: checks\ndescription: Run the appropriate checks\n---\nBODY_MUST_STAY_DEFERRED",
	);
	const result = await read("src/file.ts");
	expect(result?.instructions.map((item) => item.path)).toEqual([
		"AGENTS.md",
		"src/AGENTS.md",
	]);
	expect(result?.skills).toEqual([
		expect.objectContaining({
			name: "checks",
			path: ".agents/skills/checks/SKILL.md",
			description: "Run the appropriate checks",
			sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		}),
	]);
	expect(JSON.stringify(result)).not.toContain("BODY_MUST_STAY_DEFERRED");
	await writeFile(join(root, "src/AGENTS.md"), "Changed instructions");
	expect((await read("src/file.ts"))?.instructions[1].sha256).not.toBe(
		result?.instructions[1].sha256,
	);
});

it("rejects escaped scopes, skips symlink instructions, and marks incomplete instruction pages", async () => {
	const { root, read } = await fixture();
	await expect(read("../private")).rejects.toThrow();
	await writeFile(join(root, "private.txt"), "not instructions");
	await symlink("private.txt", join(root, "CLAUDE.md"));
	await writeFile(join(root, "AGENTS.md"), "你".repeat(16001));
	const result = await read(".");
	expect(result?.instructions).toHaveLength(1);
	expect(result?.instructions[0]).toMatchObject({
		content: "你".repeat(16000),
		nextStart: 16000,
	});
});

it("prefetches explicit local instruction documents once without recursively loading links or unreferenced skills", async () => {
	const { root, read } = await fixture();
	await mkdir(join(root, ".agents/skills/required"), { recursive: true });
	await writeFile(
		join(root, "AGENTS.md"),
		"Read [plan](PLAN.md) and [section](PLAN.md#setup). Apply [skill](.agents/skills/required/SKILL.md). [remote](https://example.com/remote.md) [escape](../outside.md) [git](.git/private.md) [symlink](alias.md)",
	);
	await writeFile(
		join(root, "PLAN.md"),
		`${"你".repeat(75000)}\n[not recursive](OTHER.md)`,
	);
	await writeFile(join(root, "OTHER.md"), "DO_NOT_RECURSE");
	await writeFile(
		join(root, ".agents/skills/required/SKILL.md"),
		"Explicitly required skill",
	);
	await symlink("OTHER.md", join(root, "alias.md"));
	const result = await read(".");
	expect(result.referencedDocuments.map((item) => item.path)).toEqual([
		"PLAN.md",
		".agents/skills/required/SKILL.md",
	]);
	expect(result.referencedDocuments[0]).toMatchObject({
		referencedBy: "AGENTS.md",
		nextStart: null,
		content: `${"你".repeat(75000)}\n[not recursive](OTHER.md)`,
		sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(JSON.stringify(result)).not.toContain("DO_NOT_RECURSE");
	expect(result.documentLimitReached).toBe(false);
});

it("bounds prefetched bodies and preserves Unicode continuation offsets", async () => {
	const { root, read } = await fixture();
	await writeFile(join(root, "AGENTS.md"), "[one](ONE.md) [two](TWO.md)");
	await writeFile(join(root, "ONE.md"), "你".repeat(90000));
	await writeFile(join(root, "TWO.md"), "界".repeat(50000));
	const result = await read(".");
	expect(result.referencedDocuments[0].content).toHaveLength(90000);
	expect(result.referencedDocuments[1]).toMatchObject({
		content: "界".repeat(38000),
		nextStart: 38000,
	});
});

it("reports references beyond the document cap instead of claiming complete preflight", async () => {
	const { root, read } = await fixture();
	await writeFile(
		join(root, "AGENTS.md"),
		Array.from({ length: 9 }, (_, index) => `[document](${index}.md)`).join(
			" ",
		),
	);
	await Promise.all(
		Array.from({ length: 9 }, (_, index) =>
			writeFile(join(root, `${index}.md`), `Document ${index}`),
		),
	);
	const result = await read(".");
	expect(result.referencedDocuments).toHaveLength(8);
	expect(result.documentLimitReached).toBe(true);
});

it("deduplicates only complete bodies still in the active transcript and reloads changed or compacted documents", async () => {
	const { root, read } = await fixture();
	await writeFile(join(root, "AGENTS.md"), "[plan](PLAN.md)");
	await writeFile(join(root, "PLAN.md"), "Original plan");
	const first = await read(".");
	const receipt: ModelMessage = {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "earlier",
				toolName: "read_repository_guidance",
				output: { type: "json", value: JSON.parse(JSON.stringify(first)) },
			},
		],
	};
	const repeated = await read(".", [receipt]);
	expect(repeated.referencedDocuments[0]).toMatchObject({
		alreadyInContext: true,
		sha256: first.referencedDocuments[0].sha256,
	});
	expect(repeated.referencedDocuments[0].content).toBeUndefined();
	expect((await read(".", [])).referencedDocuments[0].content).toBe(
		"Original plan",
	);
	await writeFile(join(root, "PLAN.md"), "Changed plan");
	expect((await read(".", [receipt])).referencedDocuments[0]).toMatchObject({
		content: "Changed plan",
	});
});

// A read-only helper runs the scan as another Linux user (ytimesy-reader), to
// whom owner-only files (umask 077 setup commands and transfers) are
// unreadable. One such file used to abort the whole scan, failing the helper
// at start; mode 000 reproduces that for the owner here.
it("skips files this agent cannot read instead of abandoning the scan", async () => {
	const { root, read } = await fixture();
	await writeFile(join(root, "AGENTS.md"), "Root rule. See [plan](PLAN.md).");
	await writeFile(join(root, "CLAUDE.md"), "private rule");
	await writeFile(join(root, "PLAN.md"), "private plan");
	await writeFile(join(root, "package.json"), "{}");
	await writeFile(join(root, "readme.txt"), "public");
	await mkdir(join(root, "build"));
	await writeFile(join(root, "build/out.js"), "built");
	await run("git", ["-C", root, "add", "build/out.js"]);
	for (const path of ["CLAUDE.md", "PLAN.md", "package.json", "build"]) {
		await chmod(join(root, path), 0o000);
		locked.push(join(root, path));
	}
	const result = await read(".");
	expect(result.instructions.map((entry) => entry.path)).toEqual(["AGENTS.md"]);
	expect(result.referencedDocuments).toEqual([]);
	expect(result.configuration).toEqual([]);
	expect(result.scopeFiles).toContain("readme.txt");
	expect(result.scopeFiles).not.toContain("build/out.js");
	expect([...(result.unreadableFiles ?? [])].sort()).toEqual([
		"CLAUDE.md",
		"PLAN.md",
		"build/out.js",
		"package.json",
	]);
	// The traversal guard still holds.
	await expect(read("../private")).rejects.toThrow(
		RepositoryGuidanceUnavailable,
	);
});

it("names why the scan could not run, and turn-start instructions degrade instead of failing the turn", async () => {
	const fixture = await localHarnessWorkspace();
	roots.push(fixture.root);
	const missing = { ...fixture.workspace, cwd: join(fixture.root, "gone") };
	const failure = await inspectRepositoryGuidance(missing, {
		scope: ".",
	}).catch((error: unknown) => error);
	expect(failure).toBeInstanceOf(RepositoryGuidanceUnavailable);
	expect((failure as Error).message).toMatch(
		/^Could not safely inspect repository guidance: FileNotFoundError/,
	);
	const sections = await readRepositoryInstructions(missing);
	expect(sections).toHaveLength(1);
	expect(sections[0].text).toContain("## Repository instructions unavailable");
	expect(sections[0].text).toContain("AGENTS.md and CLAUDE.md");
});
