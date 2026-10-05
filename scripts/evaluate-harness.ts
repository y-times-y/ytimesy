import { closeDatabase } from "#/server/adapters/database";
import { closeJobQueueForTests } from "#/server/jobs/queue";
import { runPairedEvaluation } from "../benchmarks/evaluation/run";

const [protocolPath, repositoryPath, outputPath] = process.argv.slice(2);
const userId = process.env.YTIMESY_EVALUATION_USER_ID;
if (!protocolPath || !repositoryPath || !outputPath || !userId)
	throw new Error(
		"Usage: evaluate-harness <protocol.json> <local-repo> <private-output-dir>; set YTIMESY_EVALUATION_USER_ID.",
	);

const cancelled = new AbortController();
const stop = () => cancelled.abort(new Error("Operator cancelled evaluation"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	console.info(
		await runPairedEvaluation({
			protocolPath,
			repositoryPath,
			outputPath,
			userId,
			signal: cancelled.signal,
		}),
	);
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
	await closeJobQueueForTests();
	await closeDatabase();
}
