import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { readProofVmState } from "#/server/proof/codex-login-state";
import { replaceCodexAuthSnapshot } from "#/server/proof/persist-codex-auth-snapshot";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const state = yield* Effect.tryPromise(() => readProofVmState());
	if (!state) {
		throw new Error("Proof state is missing workspaceId");
	}
	const snapshot = yield* replaceCodexAuthSnapshot(
		machines,
		WorkspaceId(state.workspaceId),
	);
	return {
		workspaceId: state.workspaceId,
		snapshot,
	};
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify(exit.value, null, 2));
	process.exit(exit.value.snapshot.kind === "failed" ? 1 : 0);
}

console.error(String(exit.cause));
process.exit(1);
