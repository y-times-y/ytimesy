import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { readAuthSnapshotState } from "#/server/proof/codex-login-state";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	connectCodexWorkspaceSession,
	emptyCodexSession,
	type PublicCodexSession,
	readCodexWorkspaceSession,
	sendCodexWorkspaceTask,
	stopCodexWorkspaceTurn,
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
		return runWithMachines(readCodexWorkspaceSession).catch(async () => {
			const snapshot = await readAuthSnapshotState().catch(() => null);
			return emptyCodexSession(Boolean(snapshot));
		});
	},
);

let inFlightConnect: Promise<PublicCodexSession> | null = null;

export const connectCodexSession = createServerFn({ method: "POST" }).handler(
	async (): Promise<PublicCodexSession> => {
		if (inFlightConnect) return inFlightConnect;
		inFlightConnect = runWithMachines(connectCodexWorkspaceSession).finally(
			() => {
				inFlightConnect = null;
			},
		);
		return inFlightConnect;
	},
);

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator(
		(data: { text: string; modelId: string; lane?: "main" | "side" }) => {
			const text = data.text.trim();
			const modelId = data.modelId.trim();
			if (!text) throw new Error("Task text is required");
			if (!modelId) throw new Error("A listed model is required");
			return {
				text,
				modelId,
				lane: data.lane === "side" ? ("side" as const) : ("main" as const),
			};
		},
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		return runWithMachines((machines) =>
			sendCodexWorkspaceTask(machines, data),
		);
	});

export const stopCodexSessionTurn = createServerFn({ method: "POST" }).handler(
	async (): Promise<PublicCodexSession> => {
		return runWithMachines(stopCodexWorkspaceTurn);
	},
);
