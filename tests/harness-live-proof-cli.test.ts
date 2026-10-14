import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);

const invalidInvocations = [
	["--dry", "10"],
	["--live", "NaN"],
	["--live", "0"],
	["--live", "11"],
] as const;
it.each(
	["prove-harness-verification", "evaluate-isolated-harness"].flatMap(
		(script) => invalidInvocations.map(([flag, cap]) => [script, flag, cap]),
	),
)(
	"rejects unapproved invocation %s %s %s before setup or provisioning",
	async (script, flag, cap) => {
		await expect(
			run(
				process.execPath,
				[
					"--import",
					"tsx",
					resolve(`scripts/${script}.ts`),
					flag,
					cap,
					"/nonexistent/development-root",
					"/nonexistent/proof-output",
				],
				{
					env: { ...process.env, YTIMESY_EVALUATION_USER_ID: "fixture-owner" },
					timeout: 15_000,
				},
			),
		).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining(`Usage: ${script}`),
		});
	},
	20_000,
);
