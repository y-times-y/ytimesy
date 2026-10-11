import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import type { WorkspaceFilePreview } from "#/domain/file-preview";
import type { SlashCommand } from "#/domain/slash-command";
import type {
	WorkspaceExplorerListing,
	WorkspaceSourceFile,
	WorkspaceSourceWrite,
} from "#/domain/workspace-explorer";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	type ExplorerScope,
	listProjectCommands,
	listWorkspaceExplorer,
	readWorkspaceExplorerFile,
	readWorkspaceFilePreview,
	writeWorkspaceExplorerFile,
} from "#/server/services/workspace-explorer";
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
				path?: string;
				text?: string;
				revision?: "head" | "working";
		  }
		| undefined,
) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	const sessionId =
		typeof data?.sessionId === "string" ? data.sessionId.trim() : "";
	const path = typeof data?.path === "string" ? data.path.trim() : "";
	const text = typeof data?.text === "string" ? data.text : undefined;
	return {
		projectId: projectId || undefined,
		sessionId: sessionId || undefined,
		path: path || undefined,
		text,
		revision:
			data?.revision === "head" ? ("head" as const) : ("working" as const),
	};
}

async function requireScope(
	projectId?: string,
	sessionId?: string,
): Promise<ExplorerScope> {
	const user = await requireUser(getRequest().headers);
	return { userId: user.id, projectId, sessionId };
}

export const listWorkspaceExplorerFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceExplorerListing> => {
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				listWorkspaceExplorer(machines, scope),
			);
		} catch {
			return { root: null, paths: [] };
		}
	});

export const readWorkspaceSourceFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceSourceFile | null> => {
		if (!data.path) return null;
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				readWorkspaceExplorerFile(machines, scope, data.path ?? ""),
			);
		} catch {
			return null;
		}
	});

export const writeWorkspaceSourceFn = createServerFn({ method: "POST" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceSourceWrite> => {
		if (!data.path || data.text == null) {
			return { ok: false, reason: "invalid" };
		}
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				writeWorkspaceExplorerFile(
					machines,
					scope,
					data.path ?? "",
					data.text ?? "",
				),
			);
		} catch {
			return { ok: false, reason: "failed" };
		}
	});

export const readWorkspacePreviewFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceFilePreview> => {
		const scope = await requireScope(data.projectId, data.sessionId);
		if (!data.path) return { kind: "unavailable", reason: "Select a file." };
		return runWithMachines((machines) =>
			readWorkspaceFilePreview(machines, scope, data.path ?? "", data.revision),
		);
	});

export const listProjectCommandsFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<SlashCommand[]> => {
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				listProjectCommands(machines, scope),
			);
		} catch {
			return [];
		}
	});
