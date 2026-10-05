import { readFile } from "node:fs/promises";
import { evaluationProtocolSchema } from "#/domain/harness-evaluation";
import { closeDatabase } from "#/server/adapters/database";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { closeJobQueueForTests } from "#/server/jobs/queue";
import { runProductionArm } from "../benchmarks/evaluation/production-arm";

const [protocolPath, taskId, outputPath] = process.argv.slice(2);
const userId = process.env.YTIMESY_EVALUATION_USER_ID;
const key = process.env.FREESTYLE_API_KEY;
if (!protocolPath || !taskId || !outputPath || !userId || !key)
	throw new Error("Missing operator evaluation configuration.");
const protocol = evaluationProtocolSchema.parse(
	JSON.parse(await readFile(protocolPath, "utf8")),
);
const task = protocol.tasks.find((entry) => entry.id === taskId);
if (!task || protocol.phase !== "development")
	throw new Error("Only selected development tasks are permitted.");
const cancelled = new AbortController();
const stop = () => cancelled.abort(new Error("Operator cancelled evaluation"));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
	await runProductionArm({
		machines: createFreestyleWorkspaceMachines(key),
		userId,
		task,
		protocol,
		outputPath,
		signal: cancelled.signal,
	});
} finally {
	process.off("SIGTERM", stop);
	process.off("SIGINT", stop);
	await closeJobQueueForTests();
	await closeDatabase();
}
