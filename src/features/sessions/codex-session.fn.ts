import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	type CodexSessionScope,
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

async function optionalScope(
	projectId?: string,
): Promise<CodexSessionScope | null> {
	try {
		const user = await requireUser(getRequest().headers);
		return { userId: user.id, projectId };
	} catch {
		return null;
	}
}

async function requireScope(projectId?: string): Promise<CodexSessionScope> {
	const user = await requireUser(getRequest().headers);
	return { userId: user.id, projectId };
}

function optionalProjectId(data: { projectId?: string } | undefined) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	return { projectId: projectId || undefined };
}

export const getCodexSession = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await optionalScope(data.projectId);
		if (!scope) return emptyCodexSession();
		return runWithMachines((machines) =>
			readCodexWorkspaceSession(machines, scope),
		).catch(() => emptyCodexSession());
	});

export const connectCodexSession = createServerFn({ method: "POST" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId);
		return runWithMachines((machines) =>
			connectCodexWorkspaceSession(machines, scope),
		);
	});

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator(
		(data: {
			text: string;
			modelId: string;
			lane?: "main" | "side";
			projectId?: string;
		}) => {
			const text = data.text.trim();
			const modelId = data.modelId.trim();
			if (!text) throw new Error("Task text is required");
			if (!modelId) throw new Error("A listed model is required");
			return {
				text,
				modelId,
				lane: data.lane === "side" ? ("side" as const) : ("main" as const),
				projectId: data.projectId?.trim() || undefined,
			};
		},
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId);
		return runWithMachines((machines) =>
			sendCodexWorkspaceTask(machines, scope, data),
		);
	});

export const stopCodexSessionTurn = createServerFn({ method: "POST" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId);
		return runWithMachines((machines) =>
			stopCodexWorkspaceTurn(machines, scope),
		);
	});
