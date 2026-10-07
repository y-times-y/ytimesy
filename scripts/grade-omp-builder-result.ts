import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	gradeEvaluationPatches,
	runEvaluatorCommand,
} from "../benchmarks/evaluation/grader";
import { ompBuilderAllowedPaths } from "../benchmarks/evaluation/omp-builder-fixture";
import type { EvaluationTask } from "../src/domain/harness-evaluation";
import { guestCapabilityDirectory } from "../src/server/services/guest-node-capability";

const directory = resolve(process.argv[2] ?? "");
if (!directory.startsWith(`${resolve(".ytimesy/omp-builder-e2e")}/`))
	throw new Error("Select a private builder attempt directory.");
const reportPath = join(directory, "result.json");
const report = JSON.parse(await readFile(reportPath, "utf8")) as {
	taskCommit: string;
	verifierSha256: string;
	graderImage: string;
	vmDeleted: boolean;
	arms: { arm: string; normalizedGrading?: unknown }[];
	artifactNormalization?: unknown;
};
if (!report.vmDeleted)
	throw new Error("Stop agents and delete the owned VM before grading.");
const run = async (args: string[], cwd = directory, input?: string) => {
	const value = await runEvaluatorCommand(args, {
		cwd,
		input,
		timeoutMs: 60000,
	});
	if (value.code) throw new Error(value.stderr);
	return value.stdout.trim();
};
const blob = (bytes: string) =>
	createHash("sha1")
		.update(`blob ${Buffer.byteLength(bytes)}\0`)
		.update(bytes)
		.digest("hex");
// The metadata hash comes from the exact operator-side archive uploaded before inference.
const metadataHash = await run([
	"python3",
	"-c",
	'import tarfile,hashlib,sys\nwith tarfile.open(sys.argv[1]) as archive:\n data=archive.extractfile("._.git").read()\n print(hashlib.sha1(b"blob "+str(len(data)).encode()+b"\\0"+data).hexdigest())',
	join(directory, "fixture-git.tar"),
]);
const expected = new Map([
	["._.git", { mode: "100755", hash: metadataHash }],
	[
		"node_modules",
		{
			mode: "120000",
			hash: blob(`${guestCapabilityDirectory("language")}/node_modules`),
		},
	],
]);
const task: EvaluationTask = {
	id: "pricing-refactor",
	benchmark: "omp-builder-development-probe",
	datasetRevision: report.taskCommit,
	commit: report.taskCommit,
	projectId: "00000000-0000-4000-8000-000000000000",
	repository: "fixture/pricing",
	branch: "main",
	prompt: "Frozen original pricing task",
	allowedPaths: ompBuilderAllowedPaths,
	verifier: {
		command: [join(directory, "verifier.cjs"), "node"],
		sha256: report.verifierSha256,
	},
};
for (const arm of report.arms) {
	const checkout = await mkdtemp(join(tmpdir(), "omp-normalize-"));
	try {
		await run([
			"git",
			"clone",
			"--no-hardlinks",
			join(directory, "fixture"),
			checkout,
		]);
		await run(["git", "checkout", "--detach", report.taskCommit], checkout);
		const patch = await readFile(join(directory, `${arm.arm}.patch`), "utf8");
		await run(["git", "apply", "--index", "--binary", "-"], checkout, patch);
		for (const [path, identity] of expected) {
			const original = await run(
				["git", "ls-tree", report.taskCommit, "--", path],
				checkout,
			);
			if (original)
				throw new Error(
					"Operator artifact unexpectedly exists in frozen task.",
				);
			const entry = await run(
				["git", "ls-files", "--stage", "--", path],
				checkout,
			);
			if (entry !== `${identity.mode} ${identity.hash} 0\t${path}`)
				throw new Error(
					"Artifact differs from operator-created bytes; do not normalize it.",
				);
		}
		await run(
			["git", "rm", "--cached", "--", "._.git", "node_modules"],
			checkout,
		);
		const normalized = `${await run(
			["git", "diff", "--cached", "--binary", report.taskCommit],
			checkout,
		)}\n`;
		await writeFile(
			join(directory, `${arm.arm}.normalized.patch`),
			normalized,
			{ mode: 0o600 },
		);
		arm.normalizedGrading = await gradeEvaluationPatches({
			repositoryPath: join(directory, "fixture"),
			task,
			patches: [normalized],
			image: report.graderImage,
			timeoutMs: 60000,
		});
		console.info(
			JSON.stringify({
				arm: arm.arm,
				normalizedGrading: arm.normalizedGrading,
			}),
		);
	} finally {
		await rm(checkout, { recursive: true, force: true });
	}
}
report.artifactNormalization = {
	removedPaths: [...expected.keys()],
	metadataBlob: metadataHash,
	dependencyLinkBlob: expected.get("node_modules")?.hash,
	reason:
		"Both were injected by operator setup before inference, identically in both arms. Byte identities verified against uploaded archive and configured guest dependency path. All other changes remain subject to the original frozen scope and verifier.",
	rawResultsPreserved: true,
	additionalModelRequests: 0,
};
await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
