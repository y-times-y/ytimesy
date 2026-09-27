import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";
import { z } from "zod";
import { requireUser } from "../../../server/auth/auth";
import { endpoint, requireSameOrigin } from "../../../server/http";
import { publishProject } from "../../../server/services/publication";

const draft = z.object({
	projectId: z.string().uuid(),
	repositoryFullName: z.string().max(256).optional(),
	sessionId: z.string().uuid().optional(),
	title: z.string().trim().min(1).max(256),
	body: z.string().max(4000).optional(),
});

export const Route = createFileRoute("/api/projects/publish")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					requireSameOrigin(request);
					const user = await requireUser(request.headers);
					const input = draft.parse(await request.json());
					const result = await Effect.runPromise(
						Effect.either(
							publishProject(user.id, {
								...input,
								authorName: user.name,
								authorEmail: user.email,
							}),
						),
					);
					if (result._tag === "Left") throw result.left.error;
					return result.right;
				}),
		},
	},
});
