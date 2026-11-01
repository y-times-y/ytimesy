import { createFileRoute } from "@tanstack/react-router";
import {
	LOCAL_IMPORT_BODY_LIMITS,
	sessionUploadRequest,
} from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	importSession,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** One local session's handoff; its transcript follows on the URL this returns. */
export const Route = createFileRoute("/api/local-import/sessions")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					return importSession(
						caller,
						await readImportJson(
							request,
							sessionUploadRequest,
							LOCAL_IMPORT_BODY_LIMITS.session,
						),
					);
				}),
		},
	},
});
