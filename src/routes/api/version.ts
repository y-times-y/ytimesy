import { createFileRoute } from "@tanstack/react-router";
import { BUILD_ID } from "../../lib/build-id";

/**
 * The build this Worker runs. Open tabs compare it with their own to reload
 * onto a new deploy (features/app/new-build-reload.ts), and the production
 * deploy's smoke check reads it to confirm the new version is serving.
 * Public and cheap: no session, no database.
 */
export const Route = createFileRoute("/api/version")({
	server: {
		handlers: {
			GET: () =>
				Response.json(
					{ build: BUILD_ID },
					{ headers: { "Cache-Control": "no-store" } },
				),
		},
	},
});
