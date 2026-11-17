import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { applyWriterPatchToParent } from "./subagent-writer";
import type { WorkspaceMachines } from "./workspace-machines";

/** A real git checkout and a machine fake that runs commands there. */
function checkout() {
	const dir = mkdtempSync(join(tmpdir(), "y-apply-"));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "t@example.invalid");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
	git("add", "-A");
	git("commit", "-q", "-m", "base");
	const machines = {
		readTextFile: async () => dir,
		exec: async (_vm: unknown, command: string) => {
			try {
				const stdout = execSync(command, {
					shell: "/bin/bash",
					encoding: "utf8",
					stdio: "pipe",
				});
				return { exitCode: 0, stdout, stderr: "" };
			} catch (error) {
				const e = error as {
					status?: number;
					stderr?: string;
					stdout?: string;
				};
				return {
					exitCode: e.status ?? 1,
					stdout: e.stdout ?? "",
					stderr: e.stderr ?? "",
				};
			}
		},
	} as unknown as WorkspaceMachines;
	/** A patch from base that changes line `two` to `text`. */
	const patchTo = (text: string) => {
		const other = mkdtempSync(join(tmpdir(), "y-patch-"));
		execFileSync("git", ["clone", "-q", dir, other]);
		writeFileSync(join(other, "a.txt"), `one\n${text}\nthree\n`);
		const patch = execFileSync("git", ["-C", other, "diff"], {
			encoding: "utf8",
		});
		const path = join(other, "change.patch");
		writeFileSync(path, patch);
		return path;
	};
	return { dir, git, machines, patchTo };
}

describe("applyWriterPatchToParent (real git)", () => {
	it("applies a clean patch to the working tree", async () => {
		const { dir, machines, patchTo } = checkout();
		const result = await applyWriterPatchToParent({
			machines,
			parentVm: WorkspaceId("vm"),
			patchPath: patchTo("TWO"),
		});
		expect(result).toEqual({ applied: true });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
	});

	it("applies two builders' patches to different lines one after another", async () => {
		const { dir, machines, git } = checkout();
		writeFileSync(join(dir, "b.txt"), "x\n");
		git("add", "-A");
		git("commit", "-q", "-m", "b");
		const first = mkdtempSync(join(tmpdir(), "y-p1-"));
		execFileSync("git", ["clone", "-q", dir, first]);
		writeFileSync(join(first, "a.txt"), "ONE\ntwo\nthree\n");
		const p1 = join(first, "1.patch");
		writeFileSync(
			p1,
			execFileSync("git", ["-C", first, "diff"], { encoding: "utf8" }),
		);
		const second = mkdtempSync(join(tmpdir(), "y-p2-"));
		execFileSync("git", ["clone", "-q", dir, second]);
		writeFileSync(join(second, "b.txt"), "y\n");
		const p2 = join(second, "2.patch");
		writeFileSync(
			p2,
			execFileSync("git", ["-C", second, "diff"], { encoding: "utf8" }),
		);
		for (const patchPath of [p1, p2])
			expect(
				await applyWriterPatchToParent({
					machines,
					parentVm: WorkspaceId("vm"),
					patchPath,
				}),
			).toEqual({ applied: true });
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("ONE\ntwo\nthree\n");
		expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("y\n");
	});

	it("changes nothing and says why when a patch conflicts with changes already applied", async () => {
		const { dir, machines, patchTo } = checkout();
		const first = patchTo("FIRST");
		const second = patchTo("SECOND");
		expect(
			await applyWriterPatchToParent({
				machines,
				parentVm: WorkspaceId("vm"),
				patchPath: first,
			}),
		).toEqual({ applied: true });
		const result = await applyWriterPatchToParent({
			machines,
			parentVm: WorkspaceId("vm"),
			patchPath: second,
		});
		expect(result.applied).toBe(false);
		if (!result.applied)
			expect(result.reason).toMatch(/patch failed|does not apply/);
		// The first builder's change stays; no conflict markers.
		const text = readFileSync(join(dir, "a.txt"), "utf8");
		expect(text).toBe("one\nFIRST\nthree\n");
		expect(text).not.toContain("<<<<<<<");
	});
});
