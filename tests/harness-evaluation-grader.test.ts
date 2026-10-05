import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	gradeEvaluationPatches,
	preflightEvaluationGrader,
	runEvaluatorCommand,
} from "../benchmarks/evaluation/grader";
import { evaluationPatchScript } from "../benchmarks/evaluation/production";
import type { EvaluationTask } from "../src/domain/harness-evaluation";

let directory: string;
let task: EvaluationTask;
let patch: string;
const image = process.env.YTIMESY_TEST_GRADER_IMAGE;
const command = (argv: string[], input?: string) =>
	runEvaluatorCommand(argv, { cwd: directory, timeoutMs: 30000, input });
beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "ytimesy-evaluation-test-"));
	await command(["git", "init", "-q"]);
	await writeFile(join(directory, "answer.js"), "module.exports = 0;\n");
	await command(["git", "add", "."]);
	await command([
		"git",
		"-c",
		"user.name=Evaluator",
		"-c",
		"user.email=evaluator@example.test",
		"commit",
		"-qm",
		"Fixture",
	]);
	const commit = (await command(["git", "rev-parse", "HEAD"])).stdout.trim();
	const verifier =
		"const assert=require('node:assert'); assert.equal(require('/workspace/answer.js'),42); assert.equal(process.env.FREESTYLE_API_KEY,undefined); assert.equal(require('node:fs').existsSync('/workspace/.git'),false);";
	await writeFile(join(directory, "verifier.cjs"), verifier);
	task = {
		id: "fixture",
		benchmark: "development",
		datasetRevision: commit,
		projectId: "11111111-1111-4111-8111-111111111111",
		repository: "owner/repo",
		branch: "main",
		commit,
		prompt: "Return 42",
		allowedPaths: ["answer.js"],
		verifier: {
			command: [join(directory, "verifier.cjs"), "node"],
			sha256: createHash("sha256").update(verifier).digest("hex"),
		},
	};
	await writeFile(join(directory, "answer.js"), "module.exports = 42;\n");
	patch = (await command(["git", "diff", "--binary"])).stdout;
});
afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

it("exports staged, unstaged and untracked changes without changing the real index", async () => {
	await writeFile(join(directory, "staged.txt"), "staged\n");
	await command(["git", "add", "staged.txt"]);
	await writeFile(join(directory, "untracked.txt"), "untracked\n");
	const indexBefore = await readFile(join(directory, ".git/index"));
	const script = evaluationPatchScript(task.commit).replace(
		'cd "$(cat /tmp/ytimesy-project-cwd)"',
		"true",
	);
	const result = await command(["sh", "-c", script]);
	expect(result.code).toBe(0);
	for (const file of ["answer.js", "staged.txt", "untracked.txt"])
		expect(result.stdout).toContain(`b/${file}`);
	expect(await readFile(join(directory, ".git/index"))).toEqual(indexBefore);
});

it("rejects a changed protected verifier before launching a grader", async () => {
	await expect(
		gradeEvaluationPatches({
			repositoryPath: directory,
			task: { ...task, verifier: { ...task.verifier, sha256: "0".repeat(64) } },
			patches: [patch],
			image: "unused",
			timeoutMs: 1000,
		}),
	).rejects.toThrow("frozen hash");
});

it("rejects protected-file edits before executing their code", async () => {
	const changed = patch.replaceAll("answer.js", "protected.js");
	// This hunk cannot apply to the original tree: integration failures are not passes.
	const result = await gradeEvaluationPatches({
		repositoryPath: directory,
		task,
		patches: [changed],
		image: "unused",
		timeoutMs: 1000,
	});
	expect(result).toMatchObject({ passed: false, failure: "integration" });
});

it("rejects a valid patch to a path outside the frozen allowlist", async () => {
	const protectedPatch =
		"diff --git a/protected.js b/protected.js\nnew file mode 100644\n--- /dev/null\n+++ b/protected.js\n@@ -0,0 +1 @@\n+process.exit(0);\n";
	expect(
		await gradeEvaluationPatches({
			repositoryPath: directory,
			task,
			patches: [protectedPatch],
			image: "unused",
			timeoutMs: 1000,
		}),
	).toMatchObject({ passed: false, failure: "scope" });
});

it.skipIf(!image)(
	"executes the real networkless Docker verifier and rejects a wrong answer",
	async () => {
		if (!image) throw new Error("Pinned grader image missing");
		await preflightEvaluationGrader({
			repositoryPath: directory,
			tasks: [task],
			image,
		});
		expect(
			await gradeEvaluationPatches({
				repositoryPath: directory,
				task,
				patches: [patch],
				image,
				timeoutMs: 15000,
			}),
		).toMatchObject({ passed: true });
		expect(
			await gradeEvaluationPatches({
				repositoryPath: directory,
				task,
				patches: [],
				image,
				timeoutMs: 15000,
			}),
		).toMatchObject({ passed: false, failure: "verifier" });
	},
	45000,
);
