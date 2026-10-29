import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	AGENT_WAIT_TOOL,
	helperTools,
	WORKTREE_WRITER_INSTRUCTIONS,
	WRITE_HELPER_INSTRUCTIONS,
} from "../evals/harbor_v2/helpers";
import type { ChildSession } from "../evals/harbor_v2/sessions";
import { trialSessions } from "../evals/harbor_v2/sessions";
import {
	applyCommands,
	worktreeRoot,
	worktreeWriters,
} from "../evals/harbor_v2/worktree-writers";
import { WorkspaceId } from "../src/domain/ids";
import { modelBilling } from "../src/domain/model-pricing";
import { orchestratorInstructions } from "../src/domain/subagent-instructions";
import {
	WRITER_PATCH_APPLY,
	WRITER_PATCH_INTEGRATION,
} from "../src/domain/writer-integration";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

const run = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A task container stand-in: every command runs in bash in `root`. */
async function container(git: boolean) {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-wt-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	await writeFile(
		join(root, "f.txt"),
		"one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
	);
	if (git) {
		await run("git", ["init", "-q", root]);
		await run("git", ["-C", root, "config", "user.name", "Fixture"]);
		await run("git", ["-C", root, "config", "user.email", "f@localhost"]);
		await writeFile(join(root, ".gitignore"), "deps/\n");
		await run("git", ["-C", root, "add", "."]);
		await run("git", ["-C", root, "commit", "-qm", "initial"]);
	}
	const sh = async (command: string, cwd = root) => {
		try {
			const out = await run("bash", ["-c", command], {
				cwd,
				maxBuffer: 8 * 1024 * 1024,
			});
			return { exitCode: 0, stdout: out.stdout, stderr: out.stderr };
		} catch (cause) {
			const error = cause as { code: number; stdout: string; stderr: string };
			return {
				exitCode: typeof error.code === "number" ? error.code : 1,
				stdout: error.stdout ?? "",
				stderr: error.stderr ?? "",
			};
		}
	};
	const machines = {
		exec: async (_vm: string, command: string) => sh(command),
		readTextFile: async (_vm: string, path: string) =>
			readFile(path, "utf8").catch(() => null),
		writeTextFile: async (_vm: string, path: string, content: string) =>
			writeFile(path, content),
	} as unknown as WorkspaceMachines;
	return { root, sh, machines };
}

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

function writersFor(box: Awaited<ReturnType<typeof container>>) {
	const trialId = `wt-${Math.random().toString(36).slice(2, 10)}`;
	cleanups.push(() =>
		rm(worktreeRoot(trialId), { recursive: true, force: true }),
	);
	const lines: string[] = [];
	const writers = worktreeWriters({
		machines: box.machines,
		vm: WorkspaceId("fixture"),
		cwd: box.root,
		trialId,
		log: (line) => lines.push(line),
	});
	return { trialId, writers, lines };
}

describe("worktreeWriters (helpers=write-tree)", () => {
	it("gives each writer a worktree with the builder's uncommitted work; disjoint patches apply cleanly", async () => {
		const box = await container(true);
		// The builder's uncommitted work and an ignored dependency directory.
		await writeFile(join(box.root, "builder.txt"), "builder's draft\n");
		await box.sh("mkdir -p deps && echo lib > deps/lib.txt");
		const { writers, trialId } = writersFor(box);
		const [a, b] = await Promise.all([
			writers.open(`${trialId}.1`),
			writers.open(`${trialId}.2`),
		]);
		expect(a.cwd).not.toBe(b.cwd);
		// Uncommitted and ignored files are in the writer's copy; HEAD and status are the builder's own.
		expect(await readFile(join(a.cwd, "builder.txt"), "utf8")).toBe(
			"builder's draft\n",
		);
		expect(await readFile(join(a.cwd, "deps/lib.txt"), "utf8")).toBe("lib\n");
		expect((await box.sh("git status --short")).stdout).toBe(
			"?? builder.txt\n",
		);
		expect((await box.sh("git log --oneline | wc -l")).stdout.trim()).toBe("1");
		// Disjoint edits: A changes line 1, B line 8 and adds a file.
		await box.sh("sed -i.bak 's/^one$/ONE/' f.txt && rm f.txt.bak", a.cwd);
		await box.sh(
			"sed -i.bak 's/^eight$/EIGHT/' f.txt && rm f.txt.bak && echo b > b.txt && git add b.txt && git commit -qm 'part B'",
			b.cwd,
		);
		const blockA = await writers.finish(`${trialId}.1`, "");
		const blockB = await writers.finish(`${trialId}.2`, "");
		const patchA = `${worktreeRoot(trialId)}/patches/${trialId}-1.patch`;
		const patchB = `${worktreeRoot(trialId)}/patches/${trialId}-2.patch`;
		// The product's patch block: path, ref and base, and how to integrate.
		expect(blockA).toContain(`Patch: ${patchA} (1 files, +1 −1`);
		expect(blockA).toMatch(
			new RegExp(`Ref: +refs/ytimesy/agents/${trialId}-1 +Base: [0-9a-f]{40}`),
		);
		expect(blockA).toContain(
			`apply with \`git add -A && git apply -3 ${patchA}\``,
		);
		expect(blockB).toContain("(2 files, +2 −1");
		// Refs are reachable from the builder's checkout: git diff <base> <ref> works there.
		const base = /Base: ([0-9a-f]{40})/.exec(blockA)?.[1] as string;
		const diff = await box.sh(
			`git diff --stat ${base} refs/ytimesy/agents/${trialId}-1`,
		);
		expect(diff.exitCode).toBe(0);
		expect(diff.stdout).toContain("f.txt");
		const applied = await box.sh(
			`git apply -3 ${patchA} && git apply -3 ${patchB} && echo ok`,
		);
		expect(applied.stdout).toContain("ok");
		expect(await readFile(join(box.root, "f.txt"), "utf8")).toBe(
			"ONE\ntwo\nthree\nfour\nfive\nsix\nseven\nEIGHT\n",
		);
		expect(await readFile(join(box.root, "b.txt"), "utf8")).toBe("b\n");
		const events = [
			{
				type: "tool-call" as const,
				id: "c1",
				name: "bash",
				input: { command: `git apply -3 ${patchA} && git apply -3 ${patchB}` },
			},
			{ type: "tool-result" as const, id: "c1", name: "bash", output: "" },
		];
		const trace = await writers.close(events);
		expect(trace.createdRepo).toBe(false);
		expect(trace.applyCommands).toBe(1);
		expect(trace.applyConflicts).toBe(0);
		expect(trace.unmergedAtEnd).toEqual([]);
		expect(trace.writers.map((writer) => writer.rounds[0])).toEqual([
			expect.objectContaining({
				base,
				ref: `refs/ytimesy/agents/${trialId}-1`,
				path: patchA,
				files: ["f.txt"],
				inFinal: true,
				applyCommands: 1,
				conflictedApplies: 0,
				patchBytes: expect.any(Number),
			}),
			expect.objectContaining({ files: ["b.txt", "f.txt"], inFinal: true }),
		]);
		expect(trace.writers[0]?.rounds[0]?.patchBytes).toBeGreaterThan(0);
		// Cleanup: worktrees, branches and refs gone; the builder's repository stays.
		expect(trace.cleanup?.ok).toBe(true);
		expect(await exists(a.cwd)).toBe(false);
		expect(await exists(worktreeRoot(trialId))).toBe(false);
		expect((await box.sh("git worktree list | wc -l")).stdout.trim()).toBe("1");
		expect((await box.sh("git branch --list 'ytimesy/*'")).stdout).toBe("");
		expect((await box.sh("git for-each-ref refs/ytimesy")).stdout).toBe("");
		expect(await exists(join(box.root, ".git"))).toBe(true);
	}, 60_000);

	it("same lines: the second patch conflicts, the builder resolves it, and the trace counts it", async () => {
		const box = await container(true);
		const { writers, trialId } = writersFor(box);
		const a = await writers.open(`${trialId}.1`);
		const b = await writers.open(`${trialId}.2`);
		await box.sh("sed -i.bak 's/^two$/TWO-A/' f.txt && rm f.txt.bak", a.cwd);
		await box.sh("sed -i.bak 's/^two$/TWO-B/' f.txt && rm f.txt.bak", b.cwd);
		const blockA = await writers.finish(`${trialId}.1`, "");
		const blockB = await writers.finish(`${trialId}.2`, "");
		// The product's overlap note: the builder hears before it applies.
		expect(blockA).not.toContain("Overlaps with");
		expect(blockB).toContain(`Overlaps with: agent ${trialId}-1 (f.txt)`);
		const patchA = `${worktreeRoot(trialId)}/patches/${trialId}-1.patch`;
		const patchB = `${worktreeRoot(trialId)}/patches/${trialId}-2.patch`;
		const first = await box.sh(`git apply -3 ${patchA}`);
		expect(first.exitCode).toBe(0);
		const second = await box.sh(`git apply -3 ${patchB}`);
		expect(second.exitCode).not.toBe(0);
		expect(second.stderr + second.stdout).toContain(
			"Applied patch to 'f.txt' with conflicts",
		);
		expect((await box.sh("git ls-files -u | wc -l")).stdout.trim()).toBe("3");
		const events = [
			{
				type: "tool-call" as const,
				id: "c1",
				name: "bash",
				input: { command: `git apply -3 ${patchA}` },
			},
			{ type: "tool-result" as const, id: "c1", name: "bash", output: "" },
			{
				type: "tool-call" as const,
				id: "c2",
				name: "bash",
				input: { command: `git apply -3 ${patchB}` },
			},
			{
				type: "tool-result" as const,
				id: "c2",
				name: "bash",
				output: `${second.stderr}${second.stdout}\nexit code 1`,
			},
		];
		// Left unresolved, the trial's end says so.
		const unresolved = applyCommands(events, [
			{ label: `${trialId}-1`, paths: [patchA] },
			{ label: `${trialId}-2`, paths: [patchB] },
		]);
		expect(unresolved.map((command) => command.conflicts)).toEqual([0, 1]);
		// The builder resolves: both changes kept, the conflict marked resolved.
		await writeFile(
			join(box.root, "f.txt"),
			"one\nTWO-A TWO-B\nthree\nfour\nfive\nsix\nseven\neight\n",
		);
		await box.sh("git add f.txt");
		const trace = await writers.close(events);
		expect(trace.applyCommands).toBe(2);
		expect(trace.applyConflicts).toBe(1);
		expect(trace.unmergedAtEnd).toEqual([]);
		expect(trace.conflictMarkersAtEnd).toEqual([]);
		expect(trace.writers[1]?.rounds[0]).toMatchObject({
			applyCommands: 1,
			conflictedApplies: 1,
			inFinal: false,
		});
		expect(trace.writers[0]?.rounds[0]).toMatchObject({
			conflictedApplies: 0,
		});
	}, 60_000);

	it("unstaged builder edits in the patched file: plain `git apply -3` refuses, staging first applies both", async () => {
		const box = await container(true);
		// A file the builder made after its last commit, before the writer started.
		await writeFile(join(box.root, "draft.txt"), "a\nb\nc\nd\ne\nf\n");
		const { writers, trialId } = writersFor(box);
		const a = await writers.open(`${trialId}.1`);
		await box.sh(
			"sed -i.bak 's/^seven$/SEVEN-W/' f.txt && sed -i.bak 's/^f$/F-W/' draft.txt && rm f.txt.bak draft.txt.bak",
			a.cwd,
		);
		await writers.finish(`${trialId}.1`, "");
		const patch = `${worktreeRoot(trialId)}/patches/${trialId}-1.patch`;
		// Meanwhile the builder edits other lines of both files, unstaged.
		await box.sh(
			"sed -i.bak 's/^one$/ONE-B/' f.txt && sed -i.bak 's/^a$/A-B/' draft.txt && rm f.txt.bak draft.txt.bak",
		);
		const plain = await box.sh(`git apply -3 ${patch}`);
		expect(plain.exitCode).not.toBe(0);
		expect(plain.stderr).toMatch(
			/does not match index|does not exist in index/,
		);
		const staged = await box.sh(WRITER_PATCH_APPLY(patch));
		expect(staged.exitCode).toBe(0);
		expect(await readFile(join(box.root, "f.txt"), "utf8")).toBe(
			"ONE-B\ntwo\nthree\nfour\nfive\nsix\nSEVEN-W\neight\n",
		);
		expect(await readFile(join(box.root, "draft.txt"), "utf8")).toBe(
			"A-B\nb\nc\nd\ne\nF-W\n",
		);
		const trace = await writers.close([
			{
				type: "tool-call" as const,
				id: "c1",
				name: "bash",
				input: { command: WRITER_PATCH_APPLY(patch) },
			},
			{ type: "tool-result" as const, id: "c1", name: "bash", output: "" },
		]);
		expect(trace.applyCommands).toBe(1);
		expect(trace.writers[0]?.rounds[0]).toMatchObject({
			inFinal: true,
			applyCommands: 1,
			conflictedApplies: 0,
		});
		expect(trace.unmergedAtEnd).toEqual([]);
	}, 60_000);

	it("unstaged builder edits on the patched lines: staging first gives a conflict the builder resolves", async () => {
		const box = await container(true);
		const { writers, trialId } = writersFor(box);
		const a = await writers.open(`${trialId}.1`);
		await box.sh("sed -i.bak 's/^four$/FOUR-W/' f.txt && rm f.txt.bak", a.cwd);
		await writers.finish(`${trialId}.1`, "");
		const patch = `${worktreeRoot(trialId)}/patches/${trialId}-1.patch`;
		await box.sh("sed -i.bak 's/^four$/FOUR-B/' f.txt && rm f.txt.bak");
		const applied = await box.sh(WRITER_PATCH_APPLY(patch));
		expect(applied.exitCode).not.toBe(0);
		expect(applied.stderr + applied.stdout).toContain(
			"Applied patch to 'f.txt' with conflicts",
		);
		const text = await readFile(join(box.root, "f.txt"), "utf8");
		expect(text).toContain("FOUR-B");
		expect(text).toContain("FOUR-W");
		expect(text).toMatch(/^<<<<<<< /m);
		// The builder resolves and marks it resolved.
		await writeFile(
			join(box.root, "f.txt"),
			"one\ntwo\nthree\nFOUR-B FOUR-W\nfive\nsix\nseven\neight\n",
		);
		await box.sh("git add f.txt");
		const trace = await writers.close([
			{
				type: "tool-call" as const,
				id: "c1",
				name: "bash",
				input: { command: WRITER_PATCH_APPLY(patch) },
			},
			{
				type: "tool-result" as const,
				id: "c1",
				name: "bash",
				output: `${applied.stderr}${applied.stdout}\nexit code 1`,
			},
		]);
		expect(trace.applyConflicts).toBe(1);
		expect(trace.unmergedAtEnd).toEqual([]);
		expect(trace.conflictMarkersAtEnd).toEqual([]);
	}, 60_000);

	it("records unmerged paths and conflict markers left at the end", async () => {
		const box = await container(true);
		const { writers, trialId, lines } = writersFor(box);
		const a = await writers.open(`${trialId}.1`);
		await box.sh("sed -i.bak 's/^two$/TWO-A/' f.txt && rm f.txt.bak", a.cwd);
		await writers.finish(`${trialId}.1`, "");
		// The builder changed the same line meanwhile (committed, so the 3-way merge runs).
		await box.sh(
			"sed -i.bak 's/^two$/TWO-BUILDER/' f.txt && rm f.txt.bak && git commit -qam builder",
		);
		const patch = `${worktreeRoot(trialId)}/patches/${trialId}-1.patch`;
		expect((await box.sh(`git apply -3 ${patch}`)).exitCode).not.toBe(0);
		const trace = await writers.close([]);
		expect(trace.unmergedAtEnd).toEqual(["f.txt"]);
		expect(trace.conflictMarkersAtEnd).toEqual(["f.txt"]);
		expect(lines.some((line) => line.includes("1 unmerged paths"))).toBe(true);
	}, 60_000);

	it("records a writer whose worktree could not be made in the trace's failures", async () => {
		const box = await container(true);
		// A file the trial user cannot read in an existing repository (the
		// live rs-archive-clone case: an execute-only tool under a root-owned .git).
		await box.sh("echo tool > tool.bin && chmod 000 tool.bin");
		cleanups.push(() => box.sh("chmod 644 tool.bin"));
		const { writers, trialId } = writersFor(box);
		await expect(writers.open(`${trialId}.1`)).rejects.toThrow(
			"its worktree could not be made",
		);
		const trace = await writers.close([]);
		expect(trace.writers).toEqual([]);
		expect(trace.failures).toEqual([
			expect.stringContaining(`${trialId}.1: its worktree could not be made`),
		]);
	}, 60_000);

	it("makes a plain directory a repository for its writers and removes it at the end", async () => {
		const box = await container(false);
		await box.sh(
			"mkdir -p .lake/packages && echo olean > .lake/packages/m.olean && head -c 21000000 /dev/zero > big.bin",
		);
		const { writers, trialId, lines } = writersFor(box);
		const a = await writers.open(`${trialId}.1`);
		expect(lines[0]).toContain("made the checkout a git repository");
		// The heavy directory and the large file stay out of git but reach the writer.
		expect((await box.sh("git ls-files")).stdout).toBe("f.txt\n");
		expect(await readFile(join(a.cwd, ".lake/packages/m.olean"), "utf8")).toBe(
			"olean\n",
		);
		expect(await exists(join(a.cwd, "big.bin"))).toBe(true);
		await box.sh("echo new > new.txt", a.cwd);
		const block = await writers.finish(`${trialId}.1`, "");
		expect(block).toContain("(1 files, +1 −0");
		// Briefed again: the next patch holds only the new work.
		await box.sh("echo more > more.txt", a.cwd);
		const again = await writers.finish(`${trialId}.1`, "");
		expect(again).toContain(`${trialId}-1-r2.patch (1 files, +1 −0`);
		// A writer with nothing new reports no changes.
		expect(await writers.finish(`${trialId}.1`, "")).toBe("Patch: no changes.");
		const trace = await writers.close([]);
		expect(trace.createdRepo).toBe(true);
		expect(trace.writers[0]?.rounds.map((round) => round.files)).toEqual([
			["new.txt"],
			["more.txt"],
			[],
		]);
		expect(await exists(join(box.root, ".git"))).toBe(false);
		expect(await exists(join(box.root, ".lake/packages/m.olean"))).toBe(true);
	}, 60_000);
});

const model = {
	modelId: "claude-opus-5-5",
	effort: "max" as const,
	billing: modelBilling({ harness: "api", modelId: "claude-opus-5-5" }),
};
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
	(
		tools[name] as { execute: (i: unknown, o: unknown) => Promise<string> }
	).execute(input, { toolCallId: "t", messages: [] });

describe("helperTools (helpers=write-tree)", () => {
	it("starts a writer without owns and appends its patch block after the report", async () => {
		const sessions = trialSessions();
		const started: { session: ChildSession; owns?: readonly string[] }[] = [];
		const tools = helperTools({
			parentId: "trial",
			sessions,
			model,
			writers: "worktree",
			start: async (session, _role, _brief, owns) => {
				started.push({ session, owns });
				return {
					outcome: "completed",
					report: `Done. ${"x".repeat(50_000)}`,
					patch: "Patch: /tmp/p.patch (1 files, +1 −0, sha256 abc)",
				};
			},
		});
		expect(JSON.stringify(tools.agent)).not.toContain('"owns"');
		expect(
			await call(tools, "agent", {
				role: "writer",
				title: "Part A",
				brief: "Build part A.",
			}),
		).toBe(
			"Started agent trial.1 (writer): Part A. Collect its report with agent_wait.",
		);
		expect(started[0]?.owns).toBeUndefined();
		expect(started[0]?.session.role).toBe("writer");
		const report = await call(tools, AGENT_WAIT_TOOL, {});
		// The report is capped; the patch block still arrives, last.
		expect(
			report.endsWith("Patch: /tmp/p.patch (1 files, +1 −0, sha256 abc)"),
		).toBe(true);
	});

	it("uses helpers=write's policy lines with the product's integration sentence as the mechanics", () => {
		const lines = WORKTREE_WRITER_INSTRUCTIONS.split("\n");
		expect(lines.slice(1, -1)).toEqual(
			WRITE_HELPER_INSTRUCTIONS.split("\n").slice(1),
		);
		expect(lines.at(-1)).toBe(WRITER_PATCH_INTEGRATION);
		expect(lines[0]).toContain("on its own git worktree of your checkout");
		expect(WORKTREE_WRITER_INSTRUCTIONS).not.toContain("owns");
		// helpers=write is unchanged: no patch integration, writers limited by owns.
		expect(WRITE_HELPER_INSTRUCTIONS).not.toContain("git apply -3");
		expect(WRITE_HELPER_INSTRUCTIONS).toContain(
			"changing only the paths you list in `owns`",
		);
		// The product's orchestration block names the same integration commands.
		const product = orchestratorInstructions();
		expect(product).toContain("`git diff <base> <ref>`");
		expect(product).toContain(WRITER_PATCH_INTEGRATION);
		expect(WRITER_PATCH_INTEGRATION).toContain(
			"`git add -A && git apply -3 <patch>`",
		);
	});
});
