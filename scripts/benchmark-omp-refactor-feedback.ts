import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Freestyle } from "freestyle";
import { z } from "zod";
import {
	gradeEvaluationPatches,
	preflightEvaluationGrader,
	runEvaluatorCommand,
} from "../benchmarks/evaluation/grader";
import { ompBuilderAllowedPaths } from "../benchmarks/evaluation/omp-builder-fixture";
import type { EvaluationTask } from "../src/domain/harness-evaluation";
import { WorkspaceId } from "../src/domain/ids";
import { posixShellQuoted as quote } from "../src/domain/posix-command";
import { CHEAP_BASE_SNAPSHOT } from "../src/server/adapters/freestyle/product-vm";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import {
	guestCapabilityCommand,
	guestCapabilityDirectory,
} from "../src/server/services/guest-node-capability";
import {
	guestServiceHostname,
	persistentGuestCapabilityRunner,
} from "../src/server/services/persistent-guest-capability";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

if (!process.argv.includes("--live"))
	throw new Error(
		"Explicit --live required for disposable compute. No model requests are made.",
	);
const original = resolve(process.argv[2]);
if (!original.startsWith(`${resolve(".ytimesy/omp-builder-e2e")}/`))
	throw new Error("Select original private attempt.");
const paired = JSON.parse(
	await readFile(join(original, "result.json"), "utf8"),
) as {
	vmDeleted: boolean;
	taskCommit: string;
	verifierSha256: string;
	graderImage: string;
};
assert.equal(paired.vmDeleted, true);
const root = process.cwd(),
	directory = resolve(".ytimesy/omp-feedback-e2e", randomUUID());
await mkdir(directory, { recursive: true, mode: 0o700 });
const command = async (args: string[], cwd = root, input?: string) => {
	const output = await runEvaluatorCommand(args, {
		cwd,
		input,
		timeoutMs: 180000,
	});
	if (output.code) throw new Error(output.stderr);
	return output.stdout.trim();
};
const before = join(directory, "before-source");
await mkdir(before);
await command(["sh", "-c", `git archive c28aaa2 | tar -x -C ${quote(before)}`]);
await symlink(join(root, "node_modules"), join(before, "node_modules"), "dir");
if (
	createRequire(
		join(before, "src/server/services/api-agent-file-tools.ts"),
	).resolve("#/domain/harness-model-profile") !==
	join(before, "src/domain/harness-model-profile.ts")
)
	throw new Error(
		"Use TSX_TSCONFIG_PATH=.ytimesy/omp-evaluation-tsconfig.json to isolate revision imports.",
	);
if (await command(["git", "status", "--porcelain", "--untracked-files=no"]))
	throw new Error("Commit the feedback fix before comparing it.");
const task: EvaluationTask = {
	id: "pricing-refactor",
	benchmark: "scripted-real-vm-capability-pipeline",
	datasetRevision: paired.taskCommit,
	commit: paired.taskCommit,
	projectId: randomUUID(),
	repository: "fixture/pricing",
	branch: "main",
	prompt:
		"Same source-fenced refactor and arithmetic fixes, executed by operator through production tools.",
	allowedPaths: ompBuilderAllowedPaths,
	verifier: {
		command: [join(original, "verifier.cjs"), "node"],
		sha256: paired.verifierSha256,
	},
};
await preflightEvaluationGrader({
	repositoryPath: join(original, "fixture"),
	tasks: [task],
	image: paired.graderImage,
});
const report: { [key: string]: unknown } = {
	baseline: await command(["git", "rev-parse", "c28aaa2"]),
	treatment: await command(["git", "rev-parse", "HEAD"]),
	scope:
		"Scripted production tool pipeline on one real VM. No model coding/selection comparison; isolates optional diagnostic wait regression.",
	inferenceRequests: 0,
	arms: [],
};
const client = new Freestyle({ apiKey: process.env.FREESTYLE_API_KEY });
let vmId: string | undefined;
const started = Date.now();
const persist = () =>
	writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2), {
		mode: 0o600,
	});
try {
	const created = await client.vms.create({
		slug: `ytimesy-omp-feedback-${randomUUID().slice(0, 8)}`,
		snapshotId: CHEAP_BASE_SNAPSHOT,
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 900,
		maxRunTotalSeconds: 900,
		idleTimeoutSeconds: 900,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-omp-feedback-evaluation" },
	});
	vmId = created.vmId;
	report.vmId = vmId;
	await persist();
	const guest = await waitUntilVmRunning(
		created.vm,
		"OMP edit feedback comparison",
	);
	assert.ok(
		guest.resources.cpu <= 4 &&
			guest.resources.memory <= 8192 &&
			guest.resources.storage <= 32768,
	);
	report.resources = guest.resources;
	const base = createFreestyleWorkspaceMachines(process.env.FREESTYLE_API_KEY);
	const machines: WorkspaceMachines = {
		...base,
		runCapability: undefined,
		async exec(id, command, timeoutMs = 30000) {
			assert.equal(id, vmId);
			const result = await created.vm.exec({ command, timeoutMs });
			return {
				exitCode: result.statusCode ?? 124,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
		},
		async writeTextFile(id, path, content) {
			assert.equal(id, vmId);
			await created.vm.fs.writeTextFile(path, content);
		},
		async readTextFile(id, path) {
			assert.equal(id, vmId);
			return created.vm.fs.readTextFile(path);
		},
	};
	const vm = WorkspaceId(vmId),
		checked = async (cmd: string, timeout = 30000) => {
			const result = await machines.exec(vm, cmd, timeout);
			assert.equal(result.exitCode, 0, result.stderr);
			return result.stdout;
		};
	const transport = {
		...machines,
		runCapability: persistentGuestCapabilityRunner(machines, (id, port) =>
			base.exposeHttp(id, port, guestServiceHostname(id, port)),
		),
	};
	await checked(
		guestCapabilityCommand("language", "console.log('{}')", {}),
		180000,
	);
	const fixture = join(original, "fixture");
	const archivePath = join(directory, "fixture-git.tar");
	await command([
		"tar",
		...(process.platform === "darwin" ? ["--no-mac-metadata"] : []),
		"-cf",
		archivePath,
		"-C",
		fixture,
		".git",
	]);
	const encoded = (await readFile(archivePath)).toString("base64");
	const load = (path: string, name: string) =>
		import(pathToFileURL(join(path, `src/server/services/${name}.ts`)).href);
	for (const [arm, path] of [
		["before", before],
		["after", root],
	] as const) {
		const cwd = `/home/ubuntu/omp-feedback-${arm}`;
		await checked(`mkdir -p ${quote(cwd)}`);
		const listing = await command(
			["git", "ls-tree", "-r", "--name-only", task.commit],
			fixture,
		);
		for (const name of listing.split("\n")) {
			await checked(`mkdir -p ${quote(join(cwd, name, ".."))}`);
			await machines.writeTextFile(
				vm,
				join(cwd, name),
				await readFile(join(fixture, name), "utf8"),
			);
		}
		const guestArchive = `/tmp/omp-feedback-${arm}.b64`;
		await machines.writeTextFile(vm, guestArchive, encoded);
		await checked(
			`base64 -d ${quote(guestArchive)} | tar -xf - -C ${quote(cwd)}`,
		);
		await checked(
			`ln -s ${quote(`${guestCapabilityDirectory("language")}/node_modules`)} ${quote(`${cwd}/node_modules`)} && printf '%s\n' node_modules '._*' >> ${quote(`${cwd}/.git/info/exclude`)}`,
		);
		assert.equal(
			(await checked(`git -C ${quote(cwd)} status --porcelain`)).trim(),
			"",
		);
		const input = {
			machines: transport,
			vm,
			cwd,
			signal: AbortSignal.timeout(300000),
			sessionId: randomUUID(),
			turnId: randomUUID(),
			readOnly: false,
			once: async (_id: string, run: () => Promise<unknown>) => run(),
		};
		const output = (
			await load(path, "agent-output-artifacts")
		).agentOutputArtifacts(input);
		const tools = {
			...(await load(path, "api-agent-file-tools")).apiAgentFileTools({
				...input,
				output,
				nativePatch: false,
			}),
			...(await load(path, "api-agent-language-tools")).apiAgentLanguageTools(
				input,
			),
			...(await load(path, "api-agent-command-tools")).apiAgentCommandTools({
				...input,
				output,
			}),
		};
		const timings: { name: string; durationMs: number }[] = [];
		const invoke = async (name: string, args: unknown) => {
			const definition = tools[name];
			assert.ok(definition.execute);
			assert.ok(definition.inputSchema instanceof z.ZodType);
			const start = Date.now();
			const result = await definition.execute(
				definition.inputSchema.parse(args),
				{ toolCallId: randomUUID(), messages: [], context: undefined },
			);
			timings.push({ name, durationMs: Date.now() - start });
			return result;
		};
		await invoke("inspect_code", {
			path: "src/ledger.ts",
			operation: "references",
			line: 1,
			column: 17,
		});
		const armStarted = Date.now();
		console.info(`${arm}: real production refactor pipeline.`);
		await invoke("rename_symbol", {
			path: "src/ledger.ts",
			line: 1,
			column: 17,
			newName: "sumPrices",
		});
		await invoke("rename_file", {
			path: "src/ledger.ts",
			newPath: "src/pricing.ts",
		});
		const selection = {
			path: "src/client.ts",
			line: 1,
			column: 1,
			kind: "source.organizeImports",
		};
		const actions = (await invoke("inspect_code", {
			...selection,
			operation: "code_actions",
		})) as { result: { index: number; sha256: string }[] };
		assert.ok(actions.result.length);
		await invoke("apply_code_action", {
			...selection,
			actionIndex: actions.result[0].index,
			actionSha256: actions.result[0].sha256,
		});
		await invoke("replace_text", {
			path: "src/pricing.ts",
			old: "(1 - discount_percent)",
			new: "(1 - discount_percent / 100)",
		});
		await invoke("replace_text", {
			path: "tools/pricing.py",
			old: "(1 - discount_percent)",
			new: "(1 - discount_percent / 100)",
		});
		const checks = await invoke("run_checks", {
			commands: ["npm test", "git diff --check"],
			outputView: "summary",
		});
		assert.ok(!JSON.stringify(checks).includes('"passed":false'));
		const patch = await checked(
			`cd ${quote(cwd)} && index=$(mktemp /tmp/omp-feedback-index.XXXXXX) && GIT_INDEX_FILE="$index" git read-tree HEAD && GIT_INDEX_FILE="$index" git add -A -- . && GIT_INDEX_FILE="$index" git diff --cached --binary ${quote(task.commit)} -- .; rm -f "$index"`,
		);
		await writeFile(join(directory, `${arm}.patch`), patch, { mode: 0o600 });
		const grading = await gradeEvaluationPatches({
			repositoryPath: fixture,
			task,
			patches: [patch],
			image: paired.graderImage,
			timeoutMs: 60000,
		});
		assert.equal(grading.passed, true, grading.detail);
		const result = {
			arm,
			elapsedMs: Date.now() - armStarted,
			timings,
			grading,
		};
		(report.arms as unknown[]).push(result);
		await persist();
		console.info(JSON.stringify(result));
	}
} finally {
	if (vmId) {
		await client.vms.ref(vmId).delete();
		report.vmDeleted = true;
	}
	report.totalElapsedMs = Date.now() - started;
	await persist();
	console.info(`Private results: ${directory}; disposable VM deleted.`);
}
