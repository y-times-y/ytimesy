import { createFileRoute } from "@tanstack/react-router";
import { serveEvidenceMedia } from "#/server/services/pr-evidence-media";

/** Pull request evidence media, for the signed-in owner of the project only. */
export const Route = createFileRoute(
	"/api/projects/$projectId/evidence/$evidenceId/$file",
)({
	server: {
		handlers: {
			GET: ({ request, params }) => serveEvidenceMedia(request, params),
			HEAD: ({ request, params }) => serveEvidenceMedia(request, params),
		},
	},
});
