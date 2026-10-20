import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { overlappingWriters } from "#/domain/subagent";
import { localVms } from "./local-vms.testing";
import {
	forkWriterWorkspace,
	parseNumstat,
	transferWriterPatch,
} from "./subagent-writer";

let cleanup: string | undefined;
afterEach(() => {
	if (cleanup) rmSync(cleanup, { recursive: true, force: true });
});

describe("writer subagent git round trip", () => {
	it("keeps the parent's uncommitted work in the fork and returns a patch the parent applies", async () => {
		const vms = localVms();
		cleanup = vms.root;
		// Uncommitted work in the parent when the writer is spawned.
		writeFileSync(
			join(vms.parentRepo, "draft.ts"),
			"export const draft = true;\n",
		);
		const fork = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-1",
		});
		expect(readFileSync(join(fork.cwd, "draft.ts"), "utf8")).toContain("draft");
		expect(
			vms.git(fork.cwd, "show", "--stat", "--format=%s", "HEAD"),
		).toContain("ytimesy fork base");
		// The child commits some work and leaves some uncommitted.
		writeFileSync(join(fork.cwd, "a.ts"), "export const a = 2;\n");
		vms.git(fork.cwd, "commit", "-qam", "child edit");
		writeFileSync(join(fork.cwd, "b.ts"), "export const b = 1;\n");
		const patch = await transferWriterPatch({
			machines: vms.machines,
			forkVm: fork.vm,
			parentVm: WorkspaceId("parent"),
			label: "1",
			base: fork.base,
			parentHead: fork.parentHead,
		});
		expect(patch).toMatchObject({
			path: "~/.ytimesy/agents/1.patch",
			files: ["a.ts", "b.ts"],
			added: 2,
			removed: 1,
			ref: "refs/ytimesy/agents/1",
			base: fork.base,
		});
		expect(patch?.sha256).toMatch(/^[0-9a-f]{64}$/);
		// The parent reviews against the ref and applies with git apply -3.
		expect(
			vms.git(
				vms.parentRepo,
				"diff",
				"--stat",
				fork.base,
				"refs/ytimesy/agents/1",
			),
		).toContain("b.ts");
		const patchFile = join(
			vms.homes.get("parent") as string,
			".ytimesy/agents/1.patch",
		);
		vms.git(vms.parentRepo, "apply", "-3", patchFile);
		expect(readFileSync(join(vms.parentRepo, "a.ts"), "utf8")).toBe(
			"export const a = 2;\n",
		);
		expect(readFileSync(join(vms.parentRepo, "b.ts"), "utf8")).toContain(
			"b = 1",
		);
		// The parent's own uncommitted draft is untouched.
		expect(readFileSync(join(vms.parentRepo, "draft.ts"), "utf8")).toContain(
			"draft",
		);
	});

	it("flags two writers on one file and git apply -3 surfaces the conflict", async () => {
		const vms = localVms();
		cleanup = vms.root;
		const parent = WorkspaceId("parent");
		const first = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: parent,
			slug: "fork-1",
		});
		const second = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: parent,
			slug: "fork-2",
		});
		writeFileSync(join(first.cwd, "shared.ts"), "line 1\nfirst\nline 3\n");
		writeFileSync(join(second.cwd, "shared.ts"), "line 1\nsecond\nline 3\n");
		const transfer = (fork: typeof first, label: string) =>
			transferWriterPatch({
				machines: vms.machines,
				forkVm: fork.vm,
				parentVm: parent,
				label,
				base: fork.base,
				parentHead: fork.parentHead,
			});
		const one = await transfer(first, "1");
		const two = await transfer(second, "2");
		expect(
			overlappingWriters(two?.files ?? [], [
				{ label: "1", files: one?.files ?? [] },
			]),
		).toEqual([{ label: "1", files: ["shared.ts"] }]);
		const agents = join(vms.homes.get("parent") as string, ".ytimesy/agents");
		vms.git(vms.parentRepo, "apply", "-3", join(agents, "1.patch"));
		expect(() =>
			execFileSync(
				"git",
				["-C", vms.parentRepo, "apply", "-3", join(agents, "2.patch")],
				{
					stdio: "pipe",
				},
			),
		).toThrow();
		expect(readFileSync(join(vms.parentRepo, "shared.ts"), "utf8")).toMatch(
			/<<<<<<<|first/,
		);
	});

	it("reports no patch when the writer changed nothing", async () => {
		const vms = localVms();
		cleanup = vms.root;
		const fork = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-1",
		});
		expect(
			await transferWriterPatch({
				machines: vms.machines,
				forkVm: fork.vm,
				parentVm: WorkspaceId("parent"),
				label: "1",
				base: fork.base,
				parentHead: fork.parentHead,
			}),
		).toBeNull();
	});

	it("parses numstat including binary files", () => {
		expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n")).toEqual({
			files: ["src/a.ts", "img.png"],
			added: 3,
			removed: 1,
		});
	});
});
