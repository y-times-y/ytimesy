import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import {
	deleteProofVmState,
	readProofVmState,
} from "#/server/proof/codex-login-state";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const state = yield* Effect.tryPromise(() => readProofVmState());
	if (!state) {
		throw new Error("Proof state is missing workspaceId");
	}
	yield* Effect.tryPromise(() =>
		machines.destroy(WorkspaceId(state.workspaceId)),
	);
	yield* Effect.tryPromise(() => deleteProofVmState());
	return {
		deletedWorkspaceId: state.workspaceId,
		keptAuthSnapshot: true,
	};
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);
if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(exit.value, null, 2));
	process.exit(0);
}
console.error(String(exit.cause));
process.exit(1);
