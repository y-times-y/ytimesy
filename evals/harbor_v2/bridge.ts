/**
 * Harbor bridge v2: runs the current ytimesy builder harness inside a Harbor
 * trial (docs/harbor-bridge-v2.md). Started by evals/harbor_v2/agent.py; the
 * frozen v13 bridge in benchmarks/harbor stays untouched.
 *
 * argv[2]: JSON { instruction, cwd, logsDir, trialId, timeoutSeconds, mcpServers }
 * Configuration: YTIMESY_HARBOR_* environment variables (config.ts).
 * Protocol: harbor-machines.ts. Logs go to stderr.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { localContextArchives } from "../../benchmarks/evaluation/local-context-archives";
import { harborBridgeConfig } from "./config";
import { harborChannel, harborMachines } from "./harbor-machines";
import { preflightRefusal } from "./preflight";
import { harborRuntime, routeApiKey } from "./runtime";
import { installTransportGuard } from "./transport-guard";
import { runHarborTrial } from "./trial";

const args = JSON.parse(process.argv[2] ?? "{}") as {
	instruction: string;
	cwd: string;
	logsDir: string;
	trialId?: string;
	/** The Harbor task name (e.g. terminal-bench/shadow-relay), for the preflight gate. */
	task?: string;
	timeoutSeconds: number;
	mcpServers?: string[];
};
const channel = harborChannel({ stdin: process.stdin, stdout: process.stdout });
const log = (line: string) => process.stderr.write(`${line}\n`);
const finish = (message: Record<string, unknown>) => {
	channel.send({ op: "done", ...message });
	process.exit(0);
};

async function harnessFingerprint() {
	const bundle = process.env.YTIMESY_BRIDGE_BUNDLE;
	return {
		name: "ytimesy",
		version: process.env.YTIMESY_HARNESS_VERSION ?? "harbor-v2",
		commit: process.env.YTIMESY_HARNESS_COMMIT ?? null,
		bundleSha256: bundle
			? createHash("sha256")
					.update(await readFile(bundle))
					.digest("hex")
			: null,
	};
}

let done: Record<string, unknown>;
try {
	const config = harborBridgeConfig(process.env);
	// Oracle 1 / nop 0 through the real grader first (preflight.ts).
	const preflight = await preflightRefusal(
		process.env.YTIMESY_HARBOR_PREFLIGHT,
		args.task,
	);
	if (preflight) {
		log(`refused: ${preflight}`);
		finish({ refused: preflight, failure: null, costUsd: 0, requests: 0 });
	}
	// A missing or malformed key fails here, before any spend is reserved.
	if (config.route !== "codex-subscription")
		await routeApiKey(config, process.env);
	installTransportGuard({ logPath: process.env.YTIMESY_TRANSPORT_LOG });
	const trialId = args.trialId || randomUUID();
	let userId = "harbor";
	let closeOperatorDatabase: (() => Promise<void>) | null = null;
	if (config.route === "codex-subscription") {
		if (!process.env.YTIMESY_EVALUATION_CODEX_AUTH_FILE)
			throw new Error(
				"The subscription route needs the operator's local Codex sign-in (YTIMESY_EVALUATION_CODEX_AUTH_FILE).",
			);
		// The product's subscription transport reads its credential from a
		// database: a loopback one per trial, holding only the access token.
		const { createOperatorEvaluationDatabase } = await import(
			"../../benchmarks/evaluation/operator-database"
		);
		const local = await createOperatorEvaluationDatabase(args.logsDir);
		process.env.DATABASE_URL = local.databaseUrl;
		process.env.BETTER_AUTH_SECRET = local.secret;
		userId = local.userId;
		closeOperatorDatabase = async () => {
			const { closeDatabase } = await import(
				"../../src/server/adapters/database"
			);
			await closeDatabase().catch(() => {});
			await local.close();
		};
	}
	const archives = localContextArchives(
		`${args.logsDir}/context-archives`,
		userId,
		trialId,
	);
	const exec = channel.exec;
	try {
		const result = await runHarborTrial({
			config,
			trialId,
			instruction: args.instruction,
			cwd: args.cwd,
			logsDir: args.logsDir,
			deadlineAt: Date.now() + args.timeoutSeconds * 1000,
			machines: harborMachines(exec),
			userId,
			storage: archives.storage,
			runtime: (wrapModel, model) =>
				harborRuntime({
					config: model
						? { ...config, modelId: model.modelId, effort: model.effort }
						: config,
					env: process.env,
					userId,
					cacheScope: model ? `${trialId}:checker` : trialId,
					wrapModel,
				}),
			mcpServers: args.mcpServers,
			harness: await harnessFingerprint(),
			log,
		});
		if (result.refused) log(`refused: ${result.refused}`);
		done = {
			refused: result.refused,
			failure: result.failure,
			inputTokens: result.usage?.inputTokens ?? null,
			cachedTokens: result.usage?.cacheReadTokens ?? null,
			outputTokens: result.usage?.outputTokens ?? null,
			costUsd: result.costUsd,
			requests: result.requests,
			reviewRounds: result.reviewRounds,
			efficiency: result.efficiency,
		};
	} finally {
		await archives.close().catch(() => {});
		await closeOperatorDatabase?.().catch(() => {});
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	log(`bridge failed before or outside the trial: ${message}`);
	done = { refused: null, failure: message, setupFailed: true };
}
finish(done);
