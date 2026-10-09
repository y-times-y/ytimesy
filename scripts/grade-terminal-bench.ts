import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gradeTerminalBenchArtifact } from "../benchmarks/evaluation/terminal-bench-verifier";

const [taskPath, artifactPath, outputPath] = process.argv.slice(2);
if (!taskPath || !artifactPath || !outputPath || !process.env.FREESTYLE_API_KEY)
	throw new Error("Missing private grader configuration.");
const output = resolve(outputPath);
if (!output.startsWith(`${resolve(".ytimesy")}/`))
	throw new Error("Grader output must remain private.");
await mkdir(output, { recursive: true, mode: 0o700 });
const cancelled = new AbortController();
const stop = () => cancelled.abort(new Error("Operator cancelled grading"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	await gradeTerminalBenchArtifact({
		apiKey: process.env.FREESTYLE_API_KEY,
		runId: randomUUID(),
		taskPath: resolve(taskPath),
		output,
		artifacts: await readFile(artifactPath),
		signal: cancelled.signal,
	});
} finally {
	process.off("SIGINT", stop);
	process.off("SIGTERM", stop);
}
