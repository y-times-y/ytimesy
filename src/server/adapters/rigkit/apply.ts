import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ENVIRONMENT_BUILD_TIMEOUT_SECONDS } from "#/domain/environment-build-limits";
import {
	type EnvironmentModel,
	environmentModel,
} from "#/domain/environment-model";
import { dispatchEnvironmentWorkflow } from "../environment-workflow-dispatch";

/** Bun owns Rigkit's SQLite engine; the Node web/queue processes never import it. */
export async function applyProjectEnvironment(
	workspaceId: string,
	force = false,
	repairModel: EnvironmentModel | null = null,
	requestId?: string,
): Promise<void> {
	if (
		await dispatchEnvironmentWorkflow(
			workspaceId,
			force,
			repairModel,
			requestId,
		)
	)
		return;
	if (!/^[a-f0-9-]{36}$/i.test(workspaceId))
		throw new Error("Invalid workspace ID.");
	const root = resolve(
		process.env.YTIMESY_RIGKIT_STATE_DIR || ".ytimesy/environments",
		workspaceId,
	);
	await mkdir(join(root, "rigkit"), { recursive: true, mode: 0o700 });
	const modulePath = resolve("src/server/adapters/rigkit/workflow.mjs");
	await writeFile(
		join(root, "rigkit/index.ts"),
		`export { environment } from ${JSON.stringify(modulePath)};\n`,
		{ mode: 0o600 },
	);
	await new Promise<void>((done, reject) => {
		const child = spawn(
			process.env.BUN_BINARY || "bun",
			[
				resolve("src/server/adapters/rigkit/runner.mjs"),
				root,
				workspaceId,
				force ? "force" : "check",
			],
			{
				env: {
					...process.env,
					YTIMESY_ENVIRONMENT_REPAIR_MODEL: JSON.stringify(
						repairModel ? environmentModel.parse(repairModel) : null,
					),
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		// Do not relay subprocess output: repository scripts may emit secrets.
		child.stderr.resume();
		let killTimeout: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
		}, ENVIRONMENT_BUILD_TIMEOUT_SECONDS * 1000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			clearTimeout(killTimeout);
			reject(new Error(`Environment worker could not start: ${error.message}`));
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			clearTimeout(killTimeout);
			code === 0
				? done()
				: reject(
						new Error(
							"Environment preparation failed. Check the project's setup status.",
						),
					);
		});
	});
}
