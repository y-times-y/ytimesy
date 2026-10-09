import { createFileRoute } from "@tanstack/react-router";
import { handleCodexSubscriptionRelay } from "../../../server/adapters/codex-subscription-transport";

export const Route = createFileRoute("/api/internal/codex-transport")({
	server: {
		handlers: { POST: ({ request }) => handleCodexSubscriptionRelay(request) },
	},
});
