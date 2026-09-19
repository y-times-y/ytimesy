import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { ProjectId } from "../../domain/ids";
import { workspaceForProject } from "../../server/adapters/workspaces";
import { requireUser } from "../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../server/http";
import {
	enqueueProjectWorkspace,
	enqueueWorkspaceSnapshotRefresh,
	workspaceView,
} from "../../server/services/workspaces";

const selection = z.object({ projectId: z.string().uuid() });

export const Route = createFileRoute("/api/workspaces")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () => {
					const user = await requireUser(request.headers);
					const projectId = selection.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					).projectId;
					const workspace = await workspaceForProject(
						user.id,
						ProjectId(projectId),
					);
					if (workspace?.status === "ready")
						void enqueueWorkspaceSnapshotRefresh(workspace.id);
					return workspace ? workspaceView(workspace) : null;
				}),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const { projectId } = selection.parse(await request.json());
					const result = await Effect.runPromise(
						Effect.either(
							enqueueProjectWorkspace(user.id, ProjectId(projectId)),
						),
					);
					if (result._tag === "Left") throw result.left.error;
					return workspaceView(result.right);
				}),
		},
	},
});
