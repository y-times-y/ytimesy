import { createFileRoute } from "@tanstack/react-router";
import { planRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	planImport,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** Where each folder of local sessions goes, or what the user must decide. */
export const Route = createFileRoute("/api/local-import/plan")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					return planImport(caller, await readImportJson(request, planRequest));
				}),
		},
	},
});
