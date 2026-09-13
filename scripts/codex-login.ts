import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { startInteractiveDeviceCodeLogin } from "#/server/adapters/codex/login-session";
import { publicLoginStatus } from "#/server/adapters/codex/login-status";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const STATE_PATH = ".ytimesy/proof-state.json";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const workspace = yield* Effect.tryPromise(() =>
		machines.createProofWorkspace({
			ttlSeconds: 45 * 60,
			idleTimeoutSeconds: -1,
		}),
	);
	const status = yield* startInteractiveDeviceCodeLogin(
		machines,
		workspace.workspaceId,
	);
	yield* Effect.tryPromise(async () => {
		await mkdir(".ytimesy", { recursive: true });
		await writeFile(
			STATE_PATH,
			`${JSON.stringify(
				{
					workspaceId: workspace.workspaceId,
					slug: workspace.slug,
					startedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
		);
	});
	return {
		workspace: {
			id: workspace.workspaceId,
			slug: workspace.slug,
			state: workspace.state,
		},
		login: publicLoginStatus(status),
	};
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(exit.value, null, 2));
	if (exit.value.login.stage === "awaiting_device_code") {
		console.log("\n========================================");
		console.log("CODEX LOGIN REQUIRED");
		console.log(`Open: ${exit.value.login.verificationUrl}`);
		console.log(`Code: ${exit.value.login.userCode}`);
		console.log("========================================\n");
	}
	process.exit(0);
}

console.error(String(exit.cause));
process.exit(1);
