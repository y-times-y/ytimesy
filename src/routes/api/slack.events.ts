import { createFileRoute } from "@tanstack/react-router";
import { handleSlackWebhook } from "#/server/slack/bot";

export const Route = createFileRoute("/api/slack/events")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					return await handleSlackWebhook(request);
				} catch (error) {
					if (error instanceof Response) return error;
					return new Response("Slack event could not be accepted.", {
						status: 503,
					});
				}
			},
		},
	},
});
