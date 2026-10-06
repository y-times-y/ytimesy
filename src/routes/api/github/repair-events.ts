import { createFileRoute } from "@tanstack/react-router";
import { receivePrRepairWebhook } from "#/server/services/pr-repair-webhook";

export const Route = createFileRoute("/api/github/repair-events")({
	server: {
		handlers: { POST: ({ request }) => receivePrRepairWebhook(request) },
	},
});
