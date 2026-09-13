import { readFile, unlink } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const STATE_PATH = ".ytimesy/proof-state.json";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const raw = yield* Effect.tryPromise(() => readFile(STATE_PATH, "utf8"));
	const parsed = JSON.parse(raw) as { workspaceId: string };
	yield* Effect.tryPromise(() =>
		machines.destroy(WorkspaceId(parsed.workspaceId)),
	);
	yield* Effect.tryPromise(() => unlink(STATE_PATH).catch(() => undefined));
	return parsed.workspaceId;
});

const exit = await Effect.runPromiseExit(
	program.pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
);
if (Exit.isSuccess(exit)) {
	console.log(`deleted ${exit.value}`);
	process.exit(0);
}
console.error(String(exit.cause));
process.exit(1);
