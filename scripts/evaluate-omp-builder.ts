import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ToolSet, tool } from "ai";
import { Freestyle } from "freestyle";
import { z } from "zod";
import {
	gradeEvaluationPatches,
	preflightEvaluationGrader,
	runEvaluatorCommand,
} from "../benchmarks/evaluation/grader";
import {
	ompBuilderAllowedPaths,
	ompBuilderFiles,
	ompBuilderPrompt,
	ompBuilderVerifier,
} from "../benchmarks/evaluation/omp-builder-fixture";
import { proveOmpGuestCapabilities } from "../benchmarks/evaluation/omp-live-capabilities";
import type { EvaluationTask } from "../src/domain/harness-evaluation";
import { WorkspaceId } from "../src/domain/ids";
import { posixShellQuoted as quote } from "../src/domain/posix-command";
import { closeDatabase, database } from "../src/server/adapters/database";
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

// Each archived package must resolve its own # imports, not the caller's tsconfig paths.
if (process.env.YTIMESY_OMP_ISOLATED_MODULES !== "1") {
	const config = resolve(".ytimesy/omp-evaluation-tsconfig.json");
	await mkdir(resolve(".ytimesy"), { recursive: true, mode: 0o700 });
	await writeFile(
		config,
		JSON.stringify({
			compilerOptions: {
				module: "ESNext",
				moduleResolution: "Bundler",
				target: "ES2022",
			},
		}),
		{ mode: 0o600 },
	);
	const status = await new Promise<number>((resolveStatus, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				new URL(import.meta.url).pathname,
				...process.argv.slice(2),
			],
			{
				stdio: "inherit",
				env: {
					...process.env,
					TSX_TSCONFIG_PATH: config,
					YTIMESY_OMP_ISOLATED_MODULES: "1",
				},
			},
		);
		child.once("error", reject);
		child.once("exit", (code) => resolveStatus(code ?? 1));
	});
	process.exit(status);
}

const live = process.argv.includes("--live");
const root = process.cwd(),
	directory = resolve(".ytimesy/omp-builder-e2e", randomUUID());
const activePath = resolve(".ytimesy/omp-builder-e2e/active.json");
const baseline = "d998928";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function command(args: string[], cwd = root, input?: string) {
	const result = await runEvaluatorCommand(args, {
		cwd,
		timeoutMs: 240000,
		input,
	});
	if (result.code)
		throw new Error(`${args[0]} failed: ${result.stderr.slice(-3000)}`);
	return result.stdout.trim();
}
async function privateFile(path: string, content: string) {
	await writeFile(path, content, { mode: 0o600 });
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const reportPath = join(directory, "result.json");
if (live) {
	try {
		await readFile(activePath);
		throw new Error(
			"An earlier live attempt exists. Audit its persisted request counter and cleanup before another run.",
		);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error;
	}
}
const source = join(directory, "before-source");
await mkdir(source, { recursive: true });
await command([
	"sh",
	"-c",
	`git archive ${baseline} | tar -x -C ${quote(source)}`,
]);
await symlink(
	join(root, "node_modules"),
	join(source, "node_modules"),
	"dir",
).catch((error) => {
	if (error.code !== "EEXIST") throw error;
});
await symlink(join(root, ".secrets"), join(source, ".secrets"), "dir").catch(
	(error) => {
		if (error.code !== "EEXIST") throw error;
	},
);
const baselineResolver = createRequire(
	join(source, "src/server/services/model-agent-loop.ts"),
);
if (
	baselineResolver.resolve("#/domain/harness-model-profile") !==
	join(source, "src/domain/harness-model-profile.ts")
)
	throw new Error("Baseline imports escaped their frozen revision.");
const fixture = join(directory, "fixture");
await mkdir(fixture, { recursive: true });
const files = ompBuilderFiles();
for (const [path, content] of Object.entries(files)) {
	await mkdir(join(fixture, path, ".."), { recursive: true });
	await privateFile(join(fixture, path), content);
}
await command(["git", "init", "-q"], fixture);
await command(["git", "add", "."], fixture);
await command(
	[
		"git",
		"-c",
		"user.name=Evaluator",
		"-c",
		"user.email=evaluator@example.invalid",
		"commit",
		"-qm",
		"Frozen pricing fixture",
	],
	fixture,
);
const commit = await command(["git", "rev-parse", "HEAD"], fixture);
const verifier = join(directory, "verifier.cjs");
await privateFile(verifier, ompBuilderVerifier);
const imageContext = join(directory, "image");
await mkdir(imageContext, { recursive: true });
await cp(
	join(root, "node_modules/typescript"),
	join(imageContext, "typescript"),
	{ recursive: true, dereference: true },
);
await privateFile(
	join(imageContext, "Dockerfile"),
	"FROM node@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f\nRUN apk add --no-cache python3\nCOPY typescript /node_modules/typescript\n",
);
await command([
	"docker",
	"build",
	"-q",
	"-t",
	"ytimesy-omp-builder-grader",
	imageContext,
]);
const image = await command([
	"docker",
	"image",
	"inspect",
	"--format",
	"{{.Id}}",
	"ytimesy-omp-builder-grader",
]);
const task: EvaluationTask = {
	id: "pricing-refactor",
	benchmark: "omp-builder-development-probe",
	datasetRevision: commit,
	commit,
	projectId: randomUUID(),
	repository: "fixture/pricing",
	branch: "main",
	prompt: ompBuilderPrompt,
	allowedPaths: ompBuilderAllowedPaths,
	verifier: { command: [verifier, "node"], sha256: hash(ompBuilderVerifier) },
};
await preflightEvaluationGrader({
	repositoryPath: fixture,
	tasks: [task],
	image,
});
const grade = (patches: string[]) =>
	gradeEvaluationPatches({
		repositoryPath: fixture,
		task,
		patches,
		image,
		timeoutMs: 60000,
	});
const broken = await grade([]);
if (broken.passed)
	throw new Error("Broken fixture incorrectly passed protected grading.");
const good = join(directory, "known-correct");
await command(["git", "clone", "--no-hardlinks", fixture, good]);
await privateFile(
	join(good, "src/pricing.ts"),
	files["src/ledger.ts"]
		.replaceAll("subtotal", "sumPrices")
		.replace("(1 - discount_percent)", "(1 - discount_percent / 100)"),
);
await command(["git", "rm", "-q", "src/ledger.ts"], good);
await privateFile(
	join(good, "src/client.ts"),
	files["src/client.ts"]
		.replace(
			'import { total } from "./ledger";\nimport { subtotal } from "./ledger";',
			'import { sumPrices, total } from "./pricing";',
		)
		.replaceAll("subtotal", "sumPrices"),
);
await privateFile(
	join(good, "src/report.ts"),
	files["src/report.ts"]
		.replaceAll("subtotal", "sumPrices")
		.replaceAll("./ledger", "./pricing"),
);
await privateFile(
	join(good, "tools/pricing.py"),
	files["tools/pricing.py"].replace(
		"(1 - discount_percent)",
		"(1 - discount_percent / 100)",
	),
);
await command(["git", "add", "-A"], good);
const correct = await grade([
	`${await command(["git", "diff", "--cached", "--binary", commit], good)}\n`,
]);
if (!correct.passed)
	throw new Error(`Known correct patch failed: ${correct.detail}`);
const treatment = await command(["git", "rev-parse", "HEAD"]);
const report: { [key: string]: unknown } = {
	scope:
		"Existing builder model loop and VM tool implementations; excludes production queue, leader delegation, review and DB journal durability.",
	baseline: await command(["git", "rev-parse", baseline]),
	treatment,
	model: "gpt-6.1-sol",
	reasoning: "low",
	taskCommit: commit,
	verifierSha256: task.verifier.sha256,
	graderImage: image,
	graderSelftest: { broken: broken.passed, correct: correct.passed },
	approved: { vmDollars: 5, modelRequests: 20 },
	arms: [],
	limitations: [
		"One synthetic task pair, sequential order and shared VM: descriptive evidence only.",
		"No native-Codex or Oh My Pi performance comparison.",
	],
};
await privateFile(reportPath, JSON.stringify(report, null, 2));
if (!live) {
	console.info(
		"Protected grader selftest passed. No VM or inference requests.",
	);
	process.exit(0);
}
if (await command(["git", "status", "--porcelain", "--untracked-files=no"]))
	throw new Error("Commit implementation before live comparison.");
const owners = await database().query<{ user_id: string }>(
	"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
);
if (owners.rows.length !== 1)
	throw new Error("Select one unambiguous connected subscription owner.");
const userId = owners.rows[0].user_id,
	key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("VM connection missing.");
const client = new Freestyle({ apiKey: key });
let vmId: string | undefined;
let totalRequests = 0;
const started = Date.now();
const active = {
	vmId: "",
	requests: 0,
	started: new Date().toISOString(),
	approvedRequests: 20,
	approvedVmDollars: 5,
};
const persist = () => privateFile(activePath, JSON.stringify(active, null, 2));
await persist();
try {
	const created = await client.vms.create({
		slug: `ytimesy-omp-builder-${randomUUID().slice(0, 8)}`,
		snapshotId: CHEAP_BASE_SNAPSHOT,
		firewall: GUEST_INTERNET_FIREWALL,
		ttlSeconds: 1800,
		maxRunTotalSeconds: 1800,
		idleTimeoutSeconds: 1800,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-omp-builder-evaluation" },
	});
	vmId = created.vmId;
	active.vmId = vmId;
	await persist();
	const running = await waitUntilVmRunning(
		created.vm,
		"OMP paired builder evaluation",
	);
	if (
		running.resources.cpu > 4 ||
		running.resources.memory > 8192 ||
		running.resources.storage > 32768
	)
		throw new Error("VM exceeds approved conservative resource envelope.");
	report.resources = running.resources;
	report.vmPriceEnvelope = {
		maximumSeconds: 1800,
		computeStorageDollars: 0.14,
		transferAllowanceDollars: 1,
		source: "https://www.freestyle.sh/pricing",
		note: "Estimate, not invoiced spend; one VM, no snapshots, hard provider lifetime.",
	};
	const base = createFreestyleWorkspaceMachines(key);
	const machines: WorkspaceMachines = {
		...base,
		runCapability: undefined,
		async exec(target, command, timeoutMs = 30000) {
			if (target !== vmId) throw new Error("Unexpected VM");
			const value = await created.vm.exec({ command, timeoutMs });
			return {
				exitCode: value.statusCode ?? 124,
				stdout: value.stdout ?? "",
				stderr: value.stderr ?? "",
			};
		},
		async writeTextFile(target, path, content) {
			if (target !== vmId) throw new Error("Unexpected VM");
			await created.vm.fs.writeTextFile(path, content);
		},
		async readTextFile(target, path) {
			if (target !== vmId) throw new Error("Unexpected VM");
			return created.vm.fs.readTextFile(path);
		},
	};
	const vm = WorkspaceId(vmId),
		deadline = AbortSignal.timeout(1500000);
	const checked = async (command: string, timeout = 30000) => {
		const value = await machines.exec(vm, command, timeout);
		if (value.exitCode)
			throw new Error(`Guest setup failed: ${value.stderr.slice(-2000)}`);
		return value.stdout;
	};
	await checked(
		"node --version && npm --version && python3 --version && git --version",
	);
	// Equal preinstalled TypeScript/server dependencies; no installation order advantage.
	const oldGuest = await import(
		pathToFileURL(join(source, "src/server/services/guest-node-capability.ts"))
			.href
	);
	await checked(
		oldGuest.guestCapabilityCommand("language", "console.log('{}')", {}),
		180000,
	);
	await checked(
		guestCapabilityCommand("language", "console.log('{}')", {}),
		180000,
	);
	report.liveCapabilities = await proveOmpGuestCapabilities(
		{
			machines: {
				...machines,
				runCapability: persistentGuestCapabilityRunner(machines, (id, port) =>
					base.exposeHttp(id, port, guestServiceHostname(id, port)),
				),
			},
			vm,
			cwd: "/home/ubuntu/omp-capability-proof",
		},
		deadline,
		(stage) => console.info(`Live capability proof: ${stage}`),
	);
	await privateFile(reportPath, JSON.stringify(report, null, 2));
	console.info("Zero-inference real VM capability proof passed.");
	const load = async (path: string, module: string) =>
		import(pathToFileURL(join(path, `src/server/${module}.ts`)).href);
	for (const [arm, path] of [
		["before", source],
		["after", root],
	] as const) {
		const cwd = `/home/ubuntu/omp-builder-${arm}`;
		await checked(`mkdir -p ${quote(cwd)}`);
		for (const [name, content] of Object.entries(files)) {
			await checked(`mkdir -p ${quote(join(cwd, name, ".."))}`);
			await machines.writeTextFile(vm, join(cwd, name), content);
		}
		// Same fixture Git history including exact frozen commit, no auth/config from host.
		const gitArchive = join(directory, "fixture-git.tar");
		await command(["tar", "-cf", gitArchive, "-C", fixture, ".git"]);
		const archive = await readFile(gitArchive);
		const archivePath = `/tmp/omp-fixture-${arm}.b64`;
		await machines.writeTextFile(vm, archivePath, archive.toString("base64"));
		await checked(
			`base64 -d ${quote(archivePath)} | tar -xf - -C ${quote(cwd)} && rm ${quote(archivePath)}`,
		);
		await checked(
			`ln -s ${quote(join(guestCapabilityDirectory("language"), "node_modules"))} ${quote(join(cwd, "node_modules"))}`,
		);
		const armMachines = {
			...machines,
			runCapability:
				arm === "after"
					? persistentGuestCapabilityRunner(machines, (id, port) =>
							base.exposeHttp(id, port, guestServiceHostname(id, port)),
						)
					: undefined,
		};
		const signal = AbortSignal.any([deadline, AbortSignal.timeout(420000)]),
			sessionId = randomUUID(),
			turnId = randomUUID();
		const receipts = new Map<string, Promise<unknown>>();
		const workspace = {
			machines: armMachines,
			vm,
			cwd,
			signal,
			sessionId,
			turnId,
			ownerSessionId: sessionId,
			readOnly: false,
			once: (id: string, run: () => Promise<unknown>) => {
				let receipt = receipts.get(id);
				if (!receipt) {
					receipt = run();
					receipts.set(id, receipt);
				}
				return receipt;
			},
		};
		const output = (
			await load(path, "services/agent-output-artifacts")
		).agentOutputArtifacts(workspace);
		const tools: ToolSet = {
			...(await load(path, "services/api-agent-file-tools")).apiAgentFileTools({
				...workspace,
				output,
				nativePatch: false,
			}),
			...(
				await load(path, "services/api-agent-language-tools")
			).apiAgentLanguageTools(workspace),
			...(
				await load(path, "services/api-agent-command-tools")
			).apiAgentCommandTools({ ...workspace, output }),
			...(await load(path, "services/node-debugger")).nodeDebuggerTools(
				workspace,
			),
			read_tool_output: output.readTool,
			read_repository_guidance: (
				await load(path, "services/repository-guidance")
			).repositoryGuidanceTool(workspace),
		};
		const scope = await load(path, "services/api-command-scope");
		tools.bash = tool({
			description:
				"Run a shell command in this isolated repository. Bounded to 30 seconds; do not publish or launch detached work.",
			inputSchema: z.object({ command: z.string().min(1).max(16000) }),
			execute: ({ command }) =>
				output.capture(
					scope.scopedShellCommand({ turnId, cwd, command, seconds: 30 }),
					30,
				),
		});
		if (arm === "after") {
			Object.assign(
				tools,
				(await load(path, "services/dap-debugger")).dapDebuggerTools(workspace),
				(await load(path, "services/code-tooling")).codeToolingTools(workspace),
			);
		}
		tools.batch_read = (
			await load(path, "services/batched-agent-reads")
		).batchedAgentReads(tools, signal);
		const runtime = await (
			await load(path, "adapters/codex-subscription")
		).codexSubscriptionModel(userId, "gpt-6.1-sol", "low", false, randomUUID());
		let requests = 0;
		const raw = runtime.model;
		runtime.model = new Proxy(raw, {
			get(target, property, receiver) {
				const value = Reflect.get(target, property, receiver);
				if (property === "doStream" || property === "doGenerate")
					return async (...args: unknown[]) => {
						if (requests >= 10 || totalRequests >= 20)
							throw new Error("Approved model request limit reached.");
						requests++;
						totalRequests++;
						active.requests = totalRequests;
						await persist();
						return value.apply(target, args);
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		runtime.compact = undefined;
		const metrics: unknown[] = [],
			events: unknown[] = [];
		const armStarted = Date.now();
		let failure: string | null = null;
		console.info(
			`${arm}: running frozen pricing task with at most 10 model requests.`,
		);
		try {
			await (await load(path, "services/model-agent-loop")).runModelAgent(
				{
					userId,
					modelId: "gpt-6.1-sol",
					reasoning: "low",
					maxSteps: 10,
					maxOutputTokens: 6000,
					messages: [{ role: "user", content: ompBuilderPrompt }],
					instructions: `You are the builder for this isolated TypeScript/Python repository at ${cwd}. Read repository guidance before implementation. Use available inspection, editing and verification tools. Finish the requested task and report observed checks. Do not publish, delegate, or access another project.`,
					tools,
					toolSurface: "implementation",
					signal,
					onEvent: async (event: unknown) => {
						events.push(event);
					},
					onStep: async () => {},
					onToolMetric: (metric: unknown) => metrics.push(metric),
					onModelMetric: (metric: unknown) => metrics.push(metric),
				},
				runtime,
			);
		} catch (error) {
			failure = error instanceof Error ? error.message : "Model loop failed";
		}
		await scope.stopApiTurnCommands({ machines, vm, cwd }, turnId);
		const patch = await checked(
			`cd ${quote(cwd)} && evaluation_index=$(mktemp /tmp/omp-evaluation-index.XXXXXX) && GIT_INDEX_FILE="$evaluation_index" git read-tree HEAD && GIT_INDEX_FILE="$evaluation_index" git add -A -- . && GIT_INDEX_FILE="$evaluation_index" git diff --cached --binary ${quote(commit)} -- .; rm -f "$evaluation_index"`,
		);
		await privateFile(join(directory, `${arm}.patch`), `${patch}\n`);
		await privateFile(
			join(directory, `${arm}.trace.json`),
			JSON.stringify({ events, metrics }, null, 2),
		);
		const grading = await grade([`${patch}\n`]);
		const result = {
			arm,
			requests,
			elapsedMs: Date.now() - armStarted,
			failure,
			grading,
			metrics,
		};
		(report.arms as unknown[]).push(result);
		report.totalRequests = totalRequests;
		await privateFile(reportPath, JSON.stringify(report, null, 2));
		console.info(
			JSON.stringify({
				arm,
				requests,
				elapsedMs: result.elapsedMs,
				passed: grading.passed,
				failure,
			}),
		);
	}
} finally {
	if (vmId) {
		await client.vms.ref(vmId).delete();
		report.vmDeleted = true;
	}
	report.totalRequests = totalRequests;
	report.totalElapsedMs = Date.now() - started;
	await privateFile(reportPath, JSON.stringify(report, null, 2));
	await closeDatabase();
	console.info(`Private results: ${reportPath}; disposable VM deleted.`);
}
