import { readFile } from "node:fs/promises";
import { harnessRegressionGate } from "#/domain/harness-regression-gate";

const path = process.argv[2];
if (!path)
	throw new Error(
		"Provide the evaluator-owned reconciled regression-gate JSON file.",
	);
const result = harnessRegressionGate(JSON.parse(await readFile(path, "utf8")));
console.info(JSON.stringify(result, null, 2));
if (result.status !== "passed") process.exitCode = 1;
