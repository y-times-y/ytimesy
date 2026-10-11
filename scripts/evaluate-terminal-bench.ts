import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { redactEvaluationText } from "../benchmarks/evaluation/artifacts";
import { startEvaluationCoordinator } from "../benchmarks/evaluation/coordination";
import { createOperatorEvaluationDatabase } from "../benchmarks/evaluation/operator-database";
import {
	closeProductionEvaluation,
	exportReviewedEvaluationPatches,
	openProductionEvaluation,
	productionEvaluationEvidence,
	productionEvaluationSnapshot,
	submitProductionEvaluation,
} from "../benchmarks/evaluation/production";
import { createTerminalBenchMachines } from "../benchmarks/evaluation/terminal-bench-machines";
import { loadTerminalBenchTask } from "../benchmarks/evaluation/terminal-bench-task";
import { terminalBenchUsage } from "../benchmarks/evaluation/terminal-bench-usage";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";
import type {
	EvaluationProtocol,
	EvaluationTask,
} from "../src/domain/harness-evaluation";
import { SessionItemId, WorkspaceId } from "../src/domain/ids";
import { posixShellCommand } from "../src/domain/posix-command";
import { environmentRecipe } from "../src/domain/project-environment";
import { agentSessionForOwner } from "../src/server/adapters/agent-sessions";
import {
	downloadCheckpoint,
	removeCheckpoint,
	removeContextArchives,
	uploadCheckpoint,
} from "../src/server/adapters/checkpoints/storage";
import { codexSubscriptionCatalog } from "../src/server/adapters/codex-subscription";
import { closeDatabase, database } from "../src/server/adapters/database";
import {
	startWorkspaceWorker,
	stopWorkspaceWorker,
} from "../src/server/jobs/worker";
import { openAgentTask } from "../src/server/services/agent-session-machine";
import { deferredApiTurnWorkspace } from "../src/server/services/api-turn-workspace";
import { commitCompletedSessionTurn } from "../src/server/services/turn-commit";

const [taskPath, outputPath, mode] = process.argv.slice(2);
if (!taskPath || !outputPath || !["preflight", "handoff", "run"].includes(mode))
	throw new Error("Specify task, private output and preflight/run mode.");
if (
	mode === "run" &&
	process.env.YTIMESY_EVALUATION_APPROVED !== "codex-subscription"
)
	throw new Error("Explicit subscription pilot approval is required.");
const output = resolve(outputPath);
if (!output.startsWith(`${resolve(".ytimesy")}/`))
	throw new Error(
		"Evaluation artifacts must remain in the private ignored directory.",
	);
await mkdir(output, { recursive: true, mode: 0o700 });
const save = (name: string, data: unknown) =>
	writeFile(
		`${output}/${name}.json`,
		redactEvaluationText(JSON.stringify(data, null, 2)),
		{ mode: 0o600 },
	);
const { task, verifierImage } = await loadTerminalBenchTask(resolve(taskPath));
const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
	encoding: "utf8",
}).trim();
const trackedDiff = execFileSync("git", ["diff", "--binary", "HEAD"], {
	encoding: "utf8",
});
const runId = randomUUID();
const key = process.env.FREESTYLE_API_KEY;
if (!key) throw new Error("Missing evaluation provider connection.");
const local = await createOperatorEvaluationDatabase(output);
process.env.DATABASE_URL = local.databaseUrl;
process.env.BETTER_AUTH_SECRET = local.secret;
process.env.APP_URL = "http://localhost:3000";
for (const name of Object.keys(process.env))
	if (
		name.startsWith("GITHUB_") ||
		name.startsWith("POSTHOG_") ||
		name.includes("DELIVERY_URL") ||
		name.includes("WORKFLOW_URL")
	)
		delete process.env[name];
Object.assign(process.env, {
	GITHUB_OAUTH_CLIENT_ID: "isolated-evaluation",
	GITHUB_OAUTH_CLIENT_SECRET: "isolated-evaluation",
	GITHUB_APP_CLIENT_ID: "isolated-evaluation",
	GITHUB_APP_CLIENT_SECRET: "isolated-evaluation",
	GITHUB_APP_SLUG: "isolated-evaluation",
	YTIMESY_HARNESS_EVALUATION_ENABLED: "1",
	// Encrypted checkpoints and context archives stay in the private output.
	YTIMESY_EVALUATION_CHECKPOINT_DIR: `${output}/checkpoints`,
	YTIMESY_INFRASTRUCTURE_ADMISSION: "false",
	YTIMESY_MODEL_CONCURRENCY: "4",
	YTIMESY_USER_TURN_CONCURRENCY: "4",
	YTIMESY_FLEET_TURN_CONCURRENCY: "4",
});
const bridge = createTerminalBenchMachines({
	apiKey: key,
	runId,
	maxVms: 6,
	onResources: (resources) => save("resources", { runId, ...resources }),
});
let worker: Awaited<ReturnType<typeof startWorkspaceWorker>> | undefined;
let coordinator:
	| Awaited<ReturnType<typeof startEvaluationCoordinator>>
	| undefined;
let attempt: Awaited<ReturnType<typeof openProductionEvaluation>> | undefined;
let archivePath: string | undefined;
const archiveSession = randomUUID();
const cancelled = new AbortController();
const stop = () => cancelled.abort(new Error("Operator cancelled evaluation"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	coordinator = await startEvaluationCoordinator();
	await save("coordinator-preflight", coordinator.preflight);
	const models = await codexSubscriptionCatalog(local.userId);
	if (!models.some((model) => model.id === "gpt-6.1-sol"))
		throw new Error("Pinned subscription model is unavailable.");
	archivePath = await uploadCheckpoint(
		local.userId,
		archiveSession,
		`preflight-${runId}`,
		"private-evaluation-roundtrip",
	);
	if (
		(await downloadCheckpoint(local.userId, archiveSession, archivePath)) !==
		"private-evaluation-roundtrip"
	)
		throw new Error("Private archive roundtrip failed.");
	await removeCheckpoint(archivePath);
	archivePath = undefined;
	const setupStarted = Date.now();
	// Production's completion gate requires a declared project check. The
	// builder-only arm has no gate, so every task gets the same neutral check:
	// it adds no task knowledge and correctness is left to the hidden grader.
	const verificationRecipe = environmentRecipe.parse({
		version: 1,
		checks: ["true"],
		timeoutSeconds: 60,
	});
	const template = await bridge.prepare(task, verificationRecipe);
	const projectId = randomUUID(),
		workspaceId = randomUUID();
	await database().query(
		"insert into project(id,user_id,repository_id,installation_id,full_name,branch) values($1,$2,$3,1,$4,'evaluation-frozen')",
		[projectId, local.userId, Date.now(), `terminal-bench/${task.id}`],
	);
	await database().query(
		"insert into workspace(id,user_id,project_id,status,provider_ref,template_snapshot_id) values($1,$2,$3,'ready',$4,$5)",
		[workspaceId, local.userId, projectId, template.vmId, template.snapshotId],
	);
	const evaluationTask: EvaluationTask = {
		id: task.id,
		benchmark: "terminal-bench-4.0-diagnostic",
		datasetRevision: baseline,
		projectId,
		repository: `terminal-bench/${task.id}`,
		branch: "evaluation-frozen",
		commit: template.commit,
		prompt: task.instruction,
		allowedPaths: ["app"],
		verifier: {
			command: ["harbor-separate-verifier"],
			sha256: task.sourceSha256,
		},
	};
	const protocol: EvaluationProtocol = {
		version: 1,
		phase: "development",
		baseline,
		modelId: "gpt-6.1-sol",
		reasoning: "max",
		seed: 0,
		repetitions: 1,
		graderImage: verifierImage,
		// Same budget as the builder-only arm: the task's own agent limit, and
		// request/token ceilings high enough never to bind before it.
		limits: {
			durationSeconds: task.agentTimeoutSeconds ?? 1800,
			modelRequests: 800,
			tokens: 100_000_000,
		},
		tasks: [evaluationTask],
	};
	await save("protocol", {
		...protocol,
		taskDescriptor: task,
		trackedDiffSha256: createHash("sha256").update(trackedDiff).digest("hex"),
		verificationRecipe,
		verificationBoundary:
			"Project admission checks syntax only; correctness requires the unchanged separate hidden grader.",
		limitations: [
			"Task agent time limit; 800-request and 100M-token ceilings across the whole lead/builder tree",
			"Task Docker images augmented with harness prerequisites",
			"Operator worker local; each writer on a separate 2-vCPU/4-GiB Freestyle VM",
		],
	});
	worker = await startWorkspaceWorker(bridge.machines);
	attempt = await openProductionEvaluation(
		bridge.machines,
		local.userId,
		evaluationTask,
		protocol,
	);
	await save("active-attempt", attempt);
	if (mode === "preflight" || mode === "handoff") {
		const child = await openAgentTask({
			userId: local.userId,
			projectId,
			parentSessionId: attempt.rootId,
			title: "Verify isolated builder checkout",
			harness: "codex",
			modelId: protocol.modelId,
			prompt: task.instruction,
			placement: "fresh",
			access: "read_write",
			execution: "parallel",
			dependsOnSessionId: null,
		});
		const boundChild = await deferredApiTurnWorkspace(
			bridge.machines,
			child,
			cancelled.signal,
		)();
		if (boundChild.vm === attempt.vmId)
			throw new Error("Writable child did not receive a separate machine.");
		const checked = await bridge.machines.exec(
			WorkspaceId(attempt.vmId),
			'cd "$(cat /tmp/ytimesy-project-cwd)" && git status --porcelain',
			15000,
		);
		if (checked.exitCode || checked.stdout.trim())
			throw new Error("Production binding modified the benchmark checkout.");
		if (mode === "handoff") {
			// No-model check of a builder's completion hand-back: one trivial edit,
			// then the exact completion step a finished builder turn runs.
			const edited = await bridge.machines.exec(
				WorkspaceId(boundChild.vm),
				'cd "$(cat /tmp/ytimesy-project-cwd)" && printf "handoff probe\\n" >> ytimesy-handoff-probe.txt && git status --porcelain',
				15000,
			);
			console.log("builder edit:", edited.exitCode, edited.stdout.trim());
			const receipts = await database().query<{ request_id: string }>(
				"select request_id from agent_task_command_receipt where parent_session_id=$1",
				[child.id],
			);
			console.log(
				"builder cwd:",
				boundChild.cwd,
				"baseline keys:",
				receipts.rows.map((row) => row.request_id),
			);
			const session = await agentSessionForOwner(local.userId, child.id);
			if (!session) throw new Error("Builder session is missing.");
			try {
				await commitCompletedSessionTurn(
					{ ...session, providerRef: boundChild.vm },
					[
						{
							kind: "userMessage",
							id: SessionItemId("probe"),
							text: task.instruction,
						},
					],
					{
						// The same capabilities a finished builder turn provides (api-turn.ts).
						exec: (providerRef, argv, _env, timeout) =>
							bridge.machines.exec(
								WorkspaceId(providerRef),
								posixShellCommand(argv),
								timeout,
							),
						readTextFile: (providerRef, path) =>
							bridge.machines.readTextFile(WorkspaceId(providerRef), path),
					} as Parameters<typeof commitCompletedSessionTurn>[2],
				);
				console.log("handoff: completion step succeeded");
			} catch (error) {
				console.log("handoff failure chain:");
				for (
					let current: unknown = error;
					current;
					current = (current as { cause?: unknown }).cause
				)
					console.log(
						" -",
						current instanceof Error
							? `${current.name}: ${current.message}`
							: String(current),
					);
			}
		}
		await save("result", {
			preflight: true,
			inferenceRequests: 0,
			setupSeconds: (Date.now() - setupStarted) / 1000,
		});
	} else {
		const started = Date.now();
		await submitProductionEvaluation(
			bridge.machines,
			local.userId,
			attempt,
			evaluationTask,
			protocol,
		);
		let state = await productionEvaluationSnapshot(
			local.userId,
			attempt.rootId,
		);
		while (
			!state.settled &&
			Date.now() - started < protocol.limits.durationSeconds * 1000 + 30_000
		) {
			cancelled.signal.throwIfAborted();
			await new Promise((done) => setTimeout(done, 1000));
			state = await productionEvaluationSnapshot(local.userId, attempt.rootId);
		}
		const evidence = await productionEvaluationEvidence(
			local.userId,
			attempt.rootId,
		);
		await save("evidence", evidence);
		const patches = await exportReviewedEvaluationPatches(
			bridge.machines,
			local.userId,
			attempt.rootId,
			template.commit,
		);
		const selected = evidence.children.find(
			(child) => child.id === patches[0].taskId,
		);
		if (!selected?.providerRef)
			throw new Error("Reviewed artifact source is missing.");
		const bytes = await bridge.exportArtifacts(
			selected.providerRef,
			task.artifacts,
			task.collectCommands,
		);
		await writeFile(`${output}/artifacts.tar.gz`, bytes, { mode: 0o600 });
		const agentSeconds = (Date.now() - started) / 1000;
		await mkdir(`${output}/official-grade`, { mode: 0o700 });
		const reward = await gradeTerminalBenchArtifact({
			apiKey: key,
			runId: randomUUID(),
			taskPath: resolve(taskPath),
			output: `${output}/official-grade`,
			artifacts: bytes,
		});
		console.log(`${task.id}: official reward ${reward}.`);
		const usage = terminalBenchUsage(evidence.turns);
		await save("result", {
			completed: true,
			rootId: attempt.rootId,
			task: task.id,
			model: protocol.modelId,
			reasoning: protocol.reasoning,
			reward,
			agentSeconds,
			setupSeconds: (started - setupStarted) / 1000,
			usage,
			artifactSha256: createHash("sha256").update(bytes).digest("hex"),
			artifacts: task.artifacts,
			private: true,
			diagnostic: true,
		});
	}
} catch (error) {
	if (attempt)
		await save(
			"evidence",
			await productionEvaluationEvidence(local.userId, attempt.rootId),
		);
	await save("failure", {
		error: error instanceof Error ? error.message : "Evaluation failed",
		task: task.id,
	});
	throw error;
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	const failures: string[] = [];
	const cleanup = async (label: string, operation: () => Promise<unknown>) => {
		try {
			await operation();
		} catch {
			failures.push(label);
		}
	};
	if (archivePath)
		await cleanup("archive preflight object", () =>
			removeCheckpoint(archivePath as string),
		);
	if (attempt) {
		const current = attempt;
		await cleanup("production tree", async () => {
			const state = await productionEvaluationSnapshot(
				local.userId,
				current.rootId,
			);
			await closeProductionEvaluation(bridge.machines, local.userId, current);
			for (const session of [state.root, ...state.children])
				await removeContextArchives(local.userId, session.id);
		});
	}
	if (worker) {
		const current = worker;
		await cleanup("worker drain", () => stopWorkspaceWorker(current));
	}
	await cleanup("owned provider resources", () => bridge.cleanup());
	if (coordinator) await cleanup("isolated coordinator", coordinator.close);
	await cleanup("application database connection", closeDatabase);
	await cleanup("local evaluation database", () => local.close());
	await save("cleanup", { complete: failures.length === 0, failures });
	if (failures.length) process.exitCode = 1;
}
