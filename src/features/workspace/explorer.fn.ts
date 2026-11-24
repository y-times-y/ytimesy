import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import type { WorkspaceFilePreview } from "#/domain/file-preview";
import type { FileChangeEntry } from "#/domain/session-item";
import type { SlashCommand } from "#/domain/slash-command";
import type {
	WorkspaceExplorerListing,
	WorkspaceSourceFile,
	WorkspaceSourceWrite,
} from "#/domain/workspace-explorer";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { enabledPluginComponents } from "#/server/adapters/plugin-installs";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	ensureSessionMachine,
	resumeSessionMachine,
} from "#/server/services/workspace-desktop";
import {
	type ExplorerScope,
	forgetChatMachine,
	listProjectCommands,
	listWorkspaceExplorer,
	readWorkspaceExplorerFile,
	readWorkspaceExplorerFiles,
	readWorkspaceFilePreview,
	readWorkspaceGitChanges,
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

/** The chat's file tree, with the file Files opens first (`path`, or the tree's first file). */
export const listWorkspaceExplorerFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<WorkspaceExplorerListing> => {
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				listWorkspaceExplorer(machines, scope, data.path),
			);
		} catch {
			return { root: null, paths: [] };
		}
	});

/** Sets up or wakes this chat's machine so Files, Terminal and Desktop can use it. */
export const wakeWorkspaceMachineFn = createServerFn({ method: "POST" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<{ ready: boolean }> => {
		requireSameOrigin(getRequest());
		const scope = await requireScope(data.projectId, data.sessionId);
		forgetChatMachine(scope);
		const ref = await runWithMachines((machines) =>
			ensureSessionMachine(machines, scope).pipe(
				Effect.catch(() => Effect.succeed(null)),
			),
		);
		return { ready: ref !== null };
	});

/** Wakes this chat's machine if it has one, ahead of a terminal or desktop opening. */
export const resumeWorkspaceMachineFn = createServerFn({ method: "POST" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<{ ready: boolean }> => {
		requireSameOrigin(getRequest());
		const scope = await requireScope(data.projectId, data.sessionId);
		forgetChatMachine(scope);
		const ready = await runWithMachines((machines) =>
			resumeSessionMachine(machines, scope).pipe(
				Effect.catch(() => Effect.succeed(false)),
			),
		);
		return { ready };
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

/** Up to four files at once, as Files reads the ones next to the open file. */
export const readWorkspaceSourcesFn = createServerFn({ method: "GET" })
	.validator(
		(
			data:
				| { projectId?: string; sessionId?: string; paths?: unknown }
				| undefined,
		) => ({
			...optionalProjectId(data),
			paths: (Array.isArray(data?.paths) ? data.paths : [])
				.filter((path): path is string => typeof path === "string")
				.map((path) => path.trim())
				.filter(Boolean)
				.slice(0, 4),
		}),
	)
	.handler(async ({ data }): Promise<(WorkspaceSourceFile | null)[]> => {
		if (!data.paths.length) return [];
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				readWorkspaceExplorerFiles(machines, scope, data.paths),
			);
		} catch {
			return data.paths.map(() => null);
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
			const [repository, plugins] = await Promise.all([
				runWithMachines((machines) => listProjectCommands(machines, scope)),
				enabledPluginComponents(scope.userId, scope.projectId ?? null),
			]);
			// Plugin commands are namespaced /<plugin>:<command>, as in Claude Code.
			return [
				...repository,
				...plugins.flatMap(({ plugin, commands }) =>
					commands.map(
						(command): SlashCommand => ({
							id: "custom",
							trigger: `/${plugin}:${command.name}`,
							label: `${plugin}:${command.name}`,
							description: command.description,
							availability: "ready",
							template: command.template,
							argumentHint: command.argumentHint,
						}),
					),
				),
			];
		} catch {
			return [];
		}
	});

/** Git-backed changes for the chat's workspace; null when its machine is asleep. */
export const readWorkspaceChangesFn = createServerFn({ method: "GET" })
	.validator(optionalProjectId)
	.handler(async ({ data }): Promise<FileChangeEntry[] | null> => {
		try {
			const scope = await requireScope(data.projectId, data.sessionId);
			return await runWithMachines((machines) =>
				readWorkspaceGitChanges(machines, scope),
			);
		} catch {
			return null;
		}
	});
