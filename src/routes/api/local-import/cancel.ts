import { createFileRoute } from "@tanstack/react-router";
import { endpoint } from "#/server/http";
import {
	cancelLocalImport,
	requireImportCaller,
} from "#/server/services/local-import";

/** `ytimesy continue --cancel`: the import stops and the card stops waiting. */
export const Route = createFileRoute("/api/local-import/cancel")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					const view = await cancelLocalImport(caller.userId, caller.importId);
					return { status: view.status };
				}),
		},
	},
});
