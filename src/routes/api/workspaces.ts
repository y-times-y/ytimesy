import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { environmentModelRequest } from "#/domain/environment-model";
import { ProjectId } from "../../domain/ids";
import { environmentBuildProgress } from "../../server/adapters/environment-build-steps";
import { workspaceForProject } from "../../server/adapters/workspaces";
import { requireUser } from "../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../server/http";
import {
	enqueueProjectWorkspace,
	workspaceStatusView,
} from "../../server/services/workspaces";

const selection = z.object({
	projectId: z.string().uuid(),
	repairModel: environmentModelRequest.optional(),
});
const read = z.object({
	projectId: z.string().uuid(),
	/** "1": the newest build's steps and output, polled while it runs. */
	progress: z.literal("1").optional(),
});

export const Route = createFileRoute("/api/workspaces")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const { projectId, progress } = read.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					const workspace = await workspaceForProject(
						user.id,
						ProjectId(projectId),
					);
					if (progress)
						return workspace
							? environmentBuildProgress(workspace.id)
							: { build: null, steps: [] };
					return workspace ? workspaceStatusView(workspace) : null;
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const { projectId, repairModel } = selection.parse(
						await request.json(),
					);
					const result = await Effect.runPromise(
						Effect.either(
							enqueueProjectWorkspace(
								user.id,
								ProjectId(projectId),
								undefined,
								repairModel,
							),
						),
					);
					if (result._tag === "Left") throw result.left.error;
					return workspaceStatusView(result.right);
				}),
		},
	},
});
