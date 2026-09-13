import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { WorkspaceId } from "../../domain/ids";
import { requireUser } from "../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../server/http";
import {
	retryProjectWorkspace,
	workspaceView,
} from "../../server/services/workspaces";

const selection = z.object({ workspaceId: z.string().uuid() });

export const Route = createFileRoute("/api/workspaces/retry")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const { workspaceId } = selection.parse(await request.json());
					const result = await Effect.runPromise(
						Effect.either(
							retryProjectWorkspace(user.id, WorkspaceId(workspaceId)),
						),
					);
					if (result._tag === "Left") throw result.left.error;
					return workspaceView(result.right);
				}),
		},
	},
});
