import { readFile } from "node:fs/promises";
import { Effect, Exit } from "effect";
import { WorkspaceId } from "#/domain/ids";
import { resumeCodexSession } from "#/server/adapters/codex/login-session";
import { publicLoginStatus } from "#/server/adapters/codex/login-status";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { WorkspaceMachineService } from "#/server/services/capabilities";

const STATE_PATH = ".ytimesy/proof-state.json";

const program = Effect.gen(function* () {
	const machines = yield* WorkspaceMachineService;
	const raw = yield* Effect.tryPromise(() => readFile(STATE_PATH, "utf8"));
	const parsed: unknown = JSON.parse(raw);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("workspaceId" in parsed) ||
		typeof parsed.workspaceId !== "string"
	) {
		throw new Error("Proof state is missing workspaceId");
	}
	const workspaceId = parsed.workspaceId;
	const status = yield* resumeCodexSession(machines, WorkspaceId(workspaceId));
	return {
		workspaceId,
		login: publicLoginStatus(status),
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
