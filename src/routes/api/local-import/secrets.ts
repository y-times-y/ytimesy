import { createFileRoute } from "@tanstack/react-router";
import { secretsRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	importSecrets,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** Variables from the folder's .env and .env.local, saved as project secrets for review. */
export const Route = createFileRoute("/api/local-import/secrets")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					return importSecrets(
						caller,
						await readImportJson(request, secretsRequest),
					);
				}),
		},
	},
});
