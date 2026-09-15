import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	type DesktopScope,
	readWorkspaceDesktop,
	startWorkspaceDesktop,
} from "#/server/services/workspace-desktop";
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

function optionalProjectId(
	data:
		| {
				projectId?: string;
				sessionId?: string;
		  }
		| undefined,
) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	const sessionId =
		typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
	return {
		projectId: projectId || undefined,
		sessionId: sessionId || undefined,
	};
}

async function requireScope(
	projectId?: string,
	sessionId?: string,
): Promise<DesktopScope> {
	const user = await requireUser(getRequest().headers);
	return { userId: user.id, projectId, sessionId };
}

export const getWorkspaceDesktop = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceDesktop> => {
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				readWorkspaceDesktop(machines, scope),
			);
		} catch {
			return { status: "stopped" };
		}
	});

export const startWorkspaceDesktopFn = createServerFn({
	method: "POST",
})
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceDesktop> => {
		const scope = await requireScope(data.projectId, data.sessionId);
		return runWithMachines((machines) =>
			startWorkspaceDesktop(machines, scope),
		);
	});
