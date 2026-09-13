import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	connectCodexWorkspaceSession,
	emptyCodexSession,
	type PublicCodexSession,
	readCodexWorkspaceSession,
	sendCodexWorkspaceTask,
} from "#/server/services/codex-workspace-session";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";

function runWithMachines<A>(
	run: (machines: WorkspaceMachines) => Effect.Effect<A>,
): Promise<A> {
	return Effect.runPromise(
		Effect.gen(function* () {
			const machines = yield* WorkspaceMachineService;
			return yield* run(machines);
		}).pipe(Effect.provide(FreestyleWorkspaceMachinesLive)),
	);
}

export const getCodexSession = createServerFn({ method: "GET" }).handler(
	async (): Promise<PublicCodexSession> => {
		return runWithMachines(readCodexWorkspaceSession).catch(() =>
			emptyCodexSession(),
		);
	},
);

export const connectCodexSession = createServerFn({ method: "POST" }).handler(
	async (): Promise<PublicCodexSession> => {
		return runWithMachines(connectCodexWorkspaceSession);
	},
);

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator((data: { text: string; modelId: string }) => {
		const text = data.text.trim();
		const modelId = data.modelId.trim();
		if (!text) throw new Error("Task text is required");
		if (!modelId) throw new Error("A listed model is required");
		return { text, modelId };
	})
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		return runWithMachines((machines) =>
			sendCodexWorkspaceTask(machines, data),
		);
	});
