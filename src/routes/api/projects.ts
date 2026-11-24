import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { projectGroupSelection, projectSelection } from "../../domain/projects";
import { listProjects } from "../../server/adapters/projects";
import { requireUserAction } from "../../server/adapters/user-action-rate";
import { requireUser } from "../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../server/http";
import {
	connectProject,
	connectProjectGroup,
} from "../../server/services/projects";
export const Route = createFileRoute("/api/projects")({
	server: {
		handlers: {
			GET: ({ request }) =>
				endpoint(async () =>
					listProjects((await requireUser(request.headers)).id),
				),
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					await requireUserAction(user.id, "project-create");
					const body = await request.json();
					const operation =
						body && typeof body === "object" && "repositories" in body
							? connectProjectGroup(user.id, projectGroupSelection.parse(body))
							: connectProject(user.id, projectSelection.parse(body));
					const result = await Effect.runPromise(Effect.result(operation));
					if (result._tag === "Failure") throw result.failure.cause;
					return result.success;
				}),
		},
	},
});
