import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { updateProjectKnowledge } from "#/domain/project-knowledge";
import {
	cachedSourceEvidence,
	sourceEvidenceMatches,
} from "#/domain/project-source-evidence";
import { inspectProjectSourceEvidence } from "./project-source-evidence";
import type { WorkspaceMachines } from "./workspace-machines";

it("invalidates remembered evidence on dirty edits and new revisions, without storing source contents", async () => {
	const root = await mkdtemp(join(tmpdir(), "ytimesy-evidence-"));
	const run = promisify(execFile);
	try {
		await run("git", ["init", "-q", root]);
		await writeFile(join(root, "source.ts"), "PRIVATE_SOURCE_CONTENT");
		await writeFile(join(root, ".env"), "PRIVATE_KEY");
		await run("git", ["-C", root, "add", "."]);
		await run("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"base",
		]);
		const machines = {
			exec: async (_vm: string, command: string) => ({
				...(await run("bash", ["-lc", command])),
				exitCode: 0,
			}),
		} as unknown as WorkspaceMachines;
		const workspace = { machines, vm: WorkspaceId("test"), cwd: root };
		const saved = await inspectProjectSourceEvidence(workspace, [
			"source.ts:12",
			".env",
			"../private",
		]);
		expect(saved.sources[1].sha256).toBeNull();
		expect(saved.sources[2].sha256).toBeNull();
		const good = { ...saved, sources: saved.sources.slice(0, 1) };
		expect(
			sourceEvidenceMatches(
				good,
				await inspectProjectSourceEvidence(workspace, ["source.ts"]),
			),
		).toBe(true);
		const document = updateProjectKnowledge("", {
			key: "module",
			title: "Module",
			content: "Reusable fact",
			sources: ["source.ts"],
			status: "observed",
			evidence: good,
		});
		expect(cachedSourceEvidence(document)).toEqual([
			{ key: "module", evidence: good },
		]);
		expect(JSON.stringify(saved)).not.toContain("PRIVATE_");
		await writeFile(join(root, "source.ts"), "changed");
		expect(
			sourceEvidenceMatches(
				good,
				await inspectProjectSourceEvidence(workspace, ["source.ts"]),
			),
		).toBe(false);
		await run("git", ["-C", root, "add", "."]);
		await run("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"changed",
		]);
		expect(
			sourceEvidenceMatches(
				good,
				await inspectProjectSourceEvidence(workspace, ["source.ts"]),
			),
		).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
