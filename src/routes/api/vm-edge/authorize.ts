import { createFileRoute } from "@tanstack/react-router";
import { authorizePreviewRequest } from "../../../server/services/vm-edge-auth";

/** Freestyle's forward-auth subrequest for private preview routes (vm-edge-auth.ts). */
export const Route = createFileRoute("/api/vm-edge/authorize")({
	server: {
		handlers: { GET: ({ request }) => authorizePreviewRequest(request) },
	},
});
