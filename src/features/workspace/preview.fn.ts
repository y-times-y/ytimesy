import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { Effect } from "effect";
import { z } from "zod";
import type { WorkspacePreviews } from "#/domain/workspace-preview";
import { FreestyleWorkspaceMachinesLive } from "#/server/adapters/freestyle/live";
import { requireUser } from "#/server/auth/auth";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import {
	listWorkspacePreviews,
	openWorkspacePreview,
	previewMachines,
	setWorkspacePreviewSharing,
} from "#/server/services/workspace-preview";

const scopeInput = z.object({
	projectId: z.uuid(),
	sessionId: z.uuid(),
});
const portInput = scopeInput.extend({
	port: z.number().int().min(1).max(65_535),
});

async function withPreviews<A>(
	run: (
		machines: ReturnType<typeof previewMachines>,
		userId: string,
	) => Promise<A>,
) {
	const user = await requireUser(getRequest().headers);
	const machines = await Effect.runPromise(
		WorkspaceMachineService.pipe(
			Effect.provide(FreestyleWorkspaceMachinesLive),
		),
	);
	return run(previewMachines(machines), user.id);
}

export const getWorkspacePreviews = createServerFn({ method: "GET" })
	.validator((data: unknown) => scopeInput.parse(data))
	.handler(
		({ data }): Promise<WorkspacePreviews> =>
			withPreviews((machines, userId) =>
				listWorkspacePreviews(machines, { userId, ...data }),
			),
	);

export const openWorkspacePreviewFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => portInput.parse(data))
	.handler(({ data }) =>
		withPreviews((machines, userId) =>
			openWorkspacePreview(
				machines,
				{ userId, projectId: data.projectId, sessionId: data.sessionId },
				data.port,
			),
		),
	);

export const setWorkspacePreviewSharingFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		portInput.extend({ shared: z.boolean() }).parse(data),
	)
	.handler(({ data }) =>
		withPreviews((machines, userId) =>
			setWorkspacePreviewSharing(
				machines,
				{ userId, projectId: data.projectId, sessionId: data.sessionId },
				data.port,
				data.shared,
			),
		),
	);
