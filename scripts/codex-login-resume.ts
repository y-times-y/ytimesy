import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { resumeCodexSession } from "#/server/adapters/codex/login-session";
import { publicLoginStatus } from "#/server/adapters/codex/login-status";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { readProofVmState } from "#/server/proof/codex-login-state";
import { persistCodexAuthSnapshotIfMissing } from "#/server/proof/persist-codex-auth-snapshot";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const state = yield* Effect.tryPromise(() => readProofVmState());
	if (!state) {
		throw new Error("Proof state is missing workspaceId");
	}
	const workspaceId = WorkspaceId(state.workspaceId);
	const status = yield* resumeCodexSession(machines, workspaceId);
	const snapshot =
		status.stage === "authenticated"
			? yield* persistCodexAuthSnapshotIfMissing(machines, workspaceId)
			: null;
	return {
		workspaceId: state.workspaceId,
		login: publicLoginStatus(status),
		snapshot,
	};
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(exit.value, null, 2));
	process.exit(exit.value.login.stage === "authenticated" ? 0 : 1);
}

console.error(String(exit.cause));
process.exit(1);
