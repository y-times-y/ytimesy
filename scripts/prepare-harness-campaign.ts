import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectEvaluationCampaign } from "../benchmarks/evaluation/campaign";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath)
	throw new Error(
		"Usage: prepare-harness-campaign <private-campaign.json> <new-private-output-directory>. No inference or deployment is performed.",
	);
const inspected = inspectEvaluationCampaign(
	JSON.parse(await readFile(manifestPath, "utf8")),
);
await promisify(execFile)("git", [
	"cat-file",
	"-e",
	`${inspected.campaign.harnessRevision}^{commit}`,
]);
const directory = resolve(outputPath);
await mkdir(directory, { mode: 0o700 });
await writeFile(
	join(directory, "campaign.json"),
	JSON.stringify(inspected, null, 2),
	{ mode: 0o600, flag: "wx" },
);
await writeFile(
	join(directory, "protocol.json"),
	JSON.stringify(inspected.campaign.protocol, null, 2),
	{ mode: 0o600, flag: "wx" },
);
console.info(
	JSON.stringify({
		status: inspected.status,
		sha256: inspected.sha256,
		independentTasks: inspected.independentTasks,
		pairedAttempts: inspected.pairedAttempts,
		armAttempts: inspected.armAttempts,
		maximumSequentialArmSeconds: inspected.maximumSequentialArmSeconds,
		limitations: inspected.limitations,
	}),
);
