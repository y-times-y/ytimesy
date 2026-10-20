import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { localVms } from "./local-vms.testing";
import { syncSidekickFork } from "./sidekick-sync";
import { forkWriterWorkspace, transferWriterPatch } from "./subagent-writer";

/**
 * A sidekick's fork across rounds, with real git in local "VMs": the lead
 * applies (or not) each round's patch and edits on its own; before the next
 * round the fork is synced with the lead's checkout, and the next patch is
 * relative to it.
 */

let cleanup: string | undefined;
afterEach(() => {
	if (cleanup) rmSync(cleanup, { recursive: true, force: true });
});

const LEAD = WorkspaceId("parent");

async function start() {
	const vms = localVms();
	cleanup = vms.root;
	const fork = await forkWriterWorkspace({
		machines: vms.machines,
		parentVm: LEAD,
		slug: "sidekick-1",
	});
	const read = (repo: string, file: string) =>
		readFileSync(join(repo, file), "utf8");
	const patchFile = (label: string) =>
		join(vms.homes.get("parent") as string, `.ytimesy/agents/${label}.patch`);
	const transfer = (label: string, base: string, parentHead: string) =>
		transferWriterPatch({
			machines: vms.machines,
			forkVm: fork.vm,
			parentVm: LEAD,
			label,
			base,
			parentHead,
		});
	const sync = (round: number, base: string, parentHead: string) =>
		syncSidekickFork({
			machines: vms.machines,
			leadVm: LEAD,
			forkVm: fork.vm,
			label: "1",
			round,
			base,
			parentHead,
		});
	return { vms, fork, read, patchFile, transfer, sync };
}

describe("sidekick fork sync", () => {
	it("persists across briefs: applied work drops out, the lead's own edits reach the fork, each patch is relative to the lead's checkout", async () => {
		const { vms, fork, read, patchFile, transfer, sync } = await start();
		// Round 1: the sidekick edits a file and adds one.
		writeFileSync(join(fork.cwd, "a.ts"), "export const a = 2;\n");
		writeFileSync(join(fork.cwd, "new.ts"), "export const fresh = true;\n");
		const first = await transfer("1", fork.base, fork.parentHead);
		expect(first?.files).toEqual(["a.ts", "new.ts"]);
		// The lead applies it, then edits on its own (tracked and untracked).
		vms.git(vms.parentRepo, "apply", "-3", patchFile("1"));
		writeFileSync(
			join(vms.parentRepo, "shared.ts"),
			"line 1\nline 2\nlead line 3\n",
		);
		writeFileSync(join(vms.parentRepo, "notes.ts"), "// lead notes\n");

		const second = await sync(2, fork.base, fork.parentHead);
		expect(second.status).toBe("clean");
		// The fork now is the lead's checkout, nothing left over.
		for (const file of ["a.ts", "new.ts", "shared.ts", "notes.ts"])
			expect(read(fork.cwd, file)).toBe(read(vms.parentRepo, file));
		expect(vms.git(fork.cwd, "status", "--porcelain")).toBe("");
		// Its round-1 head is kept under a ref.
		expect(
			vms.git(fork.cwd, "show", "refs/ytimesy/sidekick/round-1:a.ts"),
		).toBe("export const a = 2;");
		// The lead's own index and HEAD are untouched by the snapshot.
		expect(vms.git(vms.parentRepo, "status", "--porcelain")).toContain(
			"?? notes.ts",
		);

		// Round 2: only this round's change is in the patch, and it applies.
		writeFileSync(
			join(fork.cwd, "shared.ts"),
			"sidekick line 1\nline 2\nlead line 3\n",
		);
		const secondPatch = await transfer("1.r2", second.base, second.parentHead);
		expect(secondPatch).toMatchObject({
			files: ["shared.ts"],
			added: 1,
			removed: 1,
			ref: "refs/ytimesy/agents/1.r2",
			base: second.base,
		});
		expect(
			vms.git(
				vms.parentRepo,
				"diff",
				"--stat",
				second.base,
				"refs/ytimesy/agents/1.r2",
			),
		).toContain("shared.ts");
		// git apply -3 needs the touched files' worktree to match the index:
		// the lead stages its own edits first, as its instructions say.
		vms.git(vms.parentRepo, "add", "-A");
		vms.git(vms.parentRepo, "apply", "-3", patchFile("1.r2"));
		expect(read(vms.parentRepo, "shared.ts")).toBe(
			"sidekick line 1\nline 2\nlead line 3\n",
		);

		// Round 3 syncs on top of round 2's sync (the bundle's prerequisites hold).
		vms.git(vms.parentRepo, "add", "-A");
		vms.git(vms.parentRepo, "commit", "-qm", "lead commits");
		const third = await sync(3, second.base, second.parentHead);
		expect(third.status).toBe("clean");
		expect(third.parentHead).toBe(vms.git(vms.parentRepo, "rev-parse", "HEAD"));
		expect(vms.git(fork.cwd, "status", "--porcelain")).toBe("");
		expect(read(fork.cwd, "shared.ts")).toBe(read(vms.parentRepo, "shared.ts"));
	});

	it("carries work the lead has not applied on top of the lead's checkout", async () => {
		const { vms, fork, read, patchFile, transfer, sync } = await start();
		writeFileSync(join(fork.cwd, "a.ts"), "export const a = 2;\n");
		await transfer("1", fork.base, fork.parentHead);
		// The lead sends feedback without applying, after an edit of its own.
		writeFileSync(
			join(vms.parentRepo, "shared.ts"),
			"line 1\nline 2\nlead line 3\n",
		);
		const second = await sync(2, fork.base, fork.parentHead);
		expect(second.status).toBe("carried");
		expect(read(fork.cwd, "a.ts")).toBe("export const a = 2;\n");
		expect(read(fork.cwd, "shared.ts")).toBe("line 1\nline 2\nlead line 3\n");
		expect(vms.git(fork.cwd, "status", "--porcelain")).toBe("");
		// Round 2 adds a file; the patch holds all unapplied work and applies.
		writeFileSync(join(fork.cwd, "c.ts"), "export const c = 3;\n");
		const patch = await transfer("1.r2", second.base, second.parentHead);
		expect(patch?.files).toEqual(["a.ts", "c.ts"]);
		vms.git(vms.parentRepo, "apply", "-3", patchFile("1.r2"));
		expect(read(vms.parentRepo, "a.ts")).toBe("export const a = 2;\n");
		expect(read(vms.parentRepo, "shared.ts")).toBe(
			"line 1\nline 2\nlead line 3\n",
		);
	});

	it("sets conflicting unapplied work aside and leaves the fork at the lead's checkout", async () => {
		const { vms, fork, read, transfer, sync } = await start();
		writeFileSync(join(fork.cwd, "shared.ts"), "line 1\nsidekick\nline 3\n");
		await transfer("1", fork.base, fork.parentHead);
		writeFileSync(join(vms.parentRepo, "shared.ts"), "line 1\nlead\nline 3\n");
		const second = await sync(2, fork.base, fork.parentHead);
		expect(second.status).toBe("conflict");
		expect(read(fork.cwd, "shared.ts")).toBe("line 1\nlead\nline 3\n");
		expect(vms.git(fork.cwd, "status", "--porcelain")).toBe("");
		expect(
			vms.git(fork.cwd, "show", "refs/ytimesy/sidekick/round-1:shared.ts"),
		).toContain("sidekick");
		// The round-2 patch is empty until the sidekick changes something.
		expect(await transfer("1.r2", second.base, second.parentHead)).toBeNull();
	});

	it("reports unchanged when the sidekick changed nothing", async () => {
		const { fork, sync } = await start();
		expect((await sync(2, fork.base, fork.parentHead)).status).toBe(
			"unchanged",
		);
	});
});
