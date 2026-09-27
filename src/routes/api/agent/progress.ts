import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { requireUser } from "#/server/auth/auth";
import { sessionProgressResponse } from "#/server/services/session-progress";

const selection = z.object({
	projectId: z.string().uuid(),
	sessionId: z.string().uuid(),
	lane: z.enum(["main", "side"]).default("main"),
});

export const Route = createFileRoute("/api/agent/progress")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const user = await requireUser(request.headers);
					const scope = selection.parse(
						Object.fromEntries(new URL(request.url).searchParams),
					);
					return await sessionProgressResponse({
						...scope,
						userId: user.id,
						signal: request.signal,
					});
				} catch (error) {
					if (error instanceof Response) return error;
					return new Response(null, {
						status: error instanceof z.ZodError ? 400 : 503,
					});
				}
			},
		},
	},
});
