import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { parseHarnessId } from "#/server/secrets/harness-key-store";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	connectHarnessWorkspaceSession,
	emptyHarnessSession,
	type HarnessSessionScope,
	readHarnessWorkspaceSession,
	sendHarnessWorkspaceTask,
	stopHarnessWorkspaceTurn,
} from "#/server/services/harness-workspace-session";
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
	harnessId: AgentProviderId = DEFAULT_COMPOSER_HARNESS_ID,
): Promise<HarnessSessionScope | null> {
	try {
		const user = await requireUser(getRequest().headers);
		return { userId: user.id, projectId, harnessId };
	} catch {
		return null;
	}
}

async function requireScope(
	projectId?: string,
	harnessId: AgentProviderId = DEFAULT_COMPOSER_HARNESS_ID,
): Promise<HarnessSessionScope> {
	const user = await requireUser(getRequest().headers);
	return { userId: user.id, projectId, harnessId };
}

function optionalSessionInput(
	data: { projectId?: string; harnessId?: string } | undefined,
) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	const harnessId = data?.harnessId
		? parseHarnessId(data.harnessId)
		: DEFAULT_COMPOSER_HARNESS_ID;
	return { projectId: projectId || undefined, harnessId };
}

export const getCodexSession = createServerFn({ method: "GET" })
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await optionalScope(data.projectId, data.harnessId);
		if (!scope) return emptyHarnessSession();
		return runWithMachines((machines) =>
			readHarnessWorkspaceSession(machines, scope),
		).catch(() => emptyHarnessSession());
	});

export const connectCodexSession = createServerFn({ method: "POST" })
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId, data.harnessId);
		return runWithMachines((machines) =>
			connectHarnessWorkspaceSession(machines, scope),
		);
	});

export const sendCodexSessionTask = createServerFn({ method: "POST" })
	.validator(
		(data: {
			text: string;
			modelId: string;
			lane?: "main" | "side";
			projectId?: string;
			harnessId?: string;
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
				harnessId: data.harnessId
					? parseHarnessId(data.harnessId)
					: DEFAULT_COMPOSER_HARNESS_ID,
			};
		},
	)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId, data.harnessId);
		return runWithMachines((machines) =>
			sendHarnessWorkspaceTask(machines, scope, data),
		);
	});

export const stopCodexSessionTurn = createServerFn({ method: "POST" })
	.validator(optionalSessionInput)
	.handler(async ({ data }): Promise<PublicCodexSession> => {
		const scope = await requireScope(data.projectId, data.harnessId);
		return runWithMachines((machines) =>
			stopHarnessWorkspaceTurn(machines, scope),
		);
	});
