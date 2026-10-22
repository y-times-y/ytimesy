import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		// An absolute path: the parent's commands may run as another user (a
		// hard-set lead's run as root in the task container, where ~ is /root).
		expect(patch?.path).toBe(
			join(
				realpathSync(vms.homes.get("parent") as string),
				".ytimesy/agents/1.patch",
			),
		);
		expect(patch).toMatchObject({
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

	it("gives the fork the builder's commit identity when the repository names none, and keeps one it names", async () => {
		const vms = localVms();
		cleanup = vms.root;
		vms.git(vms.parentRepo, "config", "--unset", "user.email");
		vms.git(vms.parentRepo, "config", "--unset", "user.name");
		const fork = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-1",
		});
		expect(vms.git(fork.cwd, "config", "user.email")).toBe(
			"noreply@ytimesy.com",
		);
		expect(vms.git(fork.cwd, "config", "user.name")).toBe("noreply");
		// The writer's own commit, as it would run it in the fork.
		writeFileSync(join(fork.cwd, "a.ts"), "export const a = 3;\n");
		const committed = await vms.machines.exec(
			fork.vm,
			`git -C '${fork.cwd}' commit -qam 'writer edit' && git -C '${fork.cwd}' log -1 --format=%ae`,
		);
		expect(committed).toMatchObject({ exitCode: 0 });
		expect(committed.stdout.trim()).toBe("noreply@ytimesy.com");

		vms.git(vms.parentRepo, "config", "user.email", "person@example.test");
		const named = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-2",
		});
		expect(vms.git(named.cwd, "config", "user.email")).toBe(
			"person@example.test",
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

	it("keeps deliberate changes and leaves scratch, downloads and large binaries out, reporting them", async () => {
		const vms = localVms();
		cleanup = vms.root;
		writeFileSync(join(vms.parentRepo, ".gitignore"), "*.log\n");
		const fork = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-1",
		});
		const write = (path: string, contents: string | Buffer) => {
			mkdirSync(join(fork.cwd, path, ".."), { recursive: true });
			writeFileSync(join(fork.cwd, path), contents);
		};
		const binary = (bytes: number) => Buffer.alloc(bytes, 0);
		// Deliberate: a tracked edit, new source, a small asset, a named binary.
		write("a.ts", "export const a = 2;\n");
		write("src/new.ts", "export const fresh = 1;\n");
		write("src/icon.png", binary(2_000));
		write("docs/report.pdf", binary(300_000));
		// Scratch: downloads, a cache the child even committed, big binaries
		// and records, and an ignored log.
		write("downloads/photo.jpg", binary(5_000));
		write("downloads/records.json", '{"a":1}\n');
		write(".cache/x/page.html", "<html></html>\n");
		vms.git(fork.cwd, "add", "-A");
		vms.git(fork.cwd, "commit", "-qm", "child commit with scratch");
		write("dataset.parquet", binary(200_000));
		write("records.csv", "x,y\n".repeat(300_000));
		write("run.log", "noise\n");
		const patch = await transferWriterPatch({
			machines: vms.machines,
			forkVm: fork.vm,
			parentVm: WorkspaceId("parent"),
			label: "1",
			base: fork.base,
			parentHead: fork.parentHead,
			named: "Write docs/report.pdf from the data.",
		});
		expect([...(patch?.files ?? [])].sort()).toEqual([
			"a.ts",
			"docs/report.pdf",
			"src/icon.png",
			"src/new.ts",
		]);
		expect(patch?.excluded).toMatchObject({ count: 5 });
		expect(patch?.excluded?.bytes).toBeGreaterThan(1_400_000);
		expect(patch?.excluded?.paths.slice(0, 2)).toEqual([
			"records.csv",
			"dataset.parquet",
		]);
		expect(patch?.excluded?.paths).toEqual(
			expect.arrayContaining([
				"downloads/photo.jpg",
				"downloads/records.json",
				".cache/x/page.html",
			]),
		);
		// Left out of the patch and ref, not deleted from the fork.
		expect(existsSync(join(fork.cwd, "downloads/photo.jpg"))).toBe(true);
		expect(
			vms.git(fork.cwd, "ls-files", "downloads", ".cache", "records.csv"),
		).toBe("");
	});

	it("reports left-out files when they were the writer's only changes", async () => {
		const vms = localVms();
		cleanup = vms.root;
		const fork = await forkWriterWorkspace({
			machines: vms.machines,
			parentVm: WorkspaceId("parent"),
			slug: "fork-1",
		});
		mkdirSync(join(fork.cwd, "tmp"));
		writeFileSync(join(fork.cwd, "tmp/out.txt"), "scratch\n");
		await expect(
			transferWriterPatch({
				machines: vms.machines,
				forkVm: fork.vm,
				parentVm: WorkspaceId("parent"),
				label: "1",
				base: fork.base,
				parentHead: fork.parentHead,
			}),
		).rejects.toThrow(
			/changed nothing deliberate; left out 1 new file .*tmp\/out\.txt/,
		);
	});

	it("parses numstat including binary files", () => {
		expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n")).toEqual({
			files: ["src/a.ts", "img.png"],
			added: 3,
			removed: 1,
		});
	});
});
