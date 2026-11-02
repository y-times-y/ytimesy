import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { environmentModelRequest } from "#/domain/environment-model";
import { WorkspaceId } from "../../domain/ids";
import { requireUser } from "../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../server/http";
import {
	prepareWithoutSetup,
	rebuildProjectWorkspace,
	retryProjectWorkspace,
	workspaceStatusView,
} from "../../server/services/workspaces";

const selection = z.object({
	workspaceId: z.string().uuid(),
	repairModel: environmentModelRequest.optional(),
	/**
	 * retry: a failed first build again. rebuild: a ready project's environment
	 * again (after a failed rebuild). plain: clone only ("Send anyway").
	 */
	mode: z.enum(["retry", "rebuild", "plain"]).default("retry"),
});

export const Route = createFileRoute("/api/workspaces/retry")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const { workspaceId, repairModel, mode } = selection.parse(
						await request.json(),
					);
					const id = WorkspaceId(workspaceId);
					const result = await Effect.runPromise(
						Effect.either(
							mode === "plain"
								? prepareWithoutSetup(user.id, id)
								: mode === "rebuild"
									? rebuildProjectWorkspace(user.id, id, undefined, repairModel)
									: retryProjectWorkspace(user.id, id, undefined, repairModel),
						),
					);
					if (result._tag === "Left") throw result.left.error;
					return workspaceStatusView(result.right);
				}),
		},
	},
});
