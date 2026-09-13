import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { readLoginStatus } from "#/server/adapters/codex/login-session";
import { publicLoginStatus } from "#/server/adapters/codex/login-status";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import {
	readAuthSnapshotState,
	readProofVmState,
} from "#/server/proof/codex-login-state";
import { persistCodexAuthSnapshotIfMissing } from "#/server/proof/persist-codex-auth-snapshot";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const state = yield* Effect.tryPromise(() => readProofVmState());
	if (!state) {
		throw new Error("Proof state is missing workspaceId");
	}
	const workspaceId = WorkspaceId(state.workspaceId);
	const status = yield* readLoginStatus(machines, workspaceId);
	const snapshot =
		status.stage === "authenticated"
			? yield* persistCodexAuthSnapshotIfMissing(machines, workspaceId)
			: existingSnapshotRecord(
					yield* Effect.tryPromise(() => readAuthSnapshotState()),
				);
	return {
		workspaceId: state.workspaceId,
		login: publicLoginStatus(status),
		snapshot,
	};
});

function existingSnapshotRecord(
	existing: Awaited<ReturnType<typeof readAuthSnapshotState>>,
) {
	return existing ? { kind: "existing" as const, snapshot: existing } : null;
}

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
	if (exit.value.snapshot?.kind === "created") {
		console.log(
			"\nPrivate Codex auth snapshot stored. Later `pnpm prove:codex-login` boots from it without a new device code. `pnpm prove:codex-login:cleanup` deletes this VM and keeps the snapshot.\n",
		);
	}
	process.exit(0);
}

console.error(String(exit.cause));
process.exit(1);
