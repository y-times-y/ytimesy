import { createFileRoute } from "@tanstack/react-router";
import { startRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import { startLocalImport } from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** The CLI spends the card's one-time code for its import token. */
export const Route = createFileRoute("/api/local-import/start")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () =>
					startLocalImport(await readImportJson(request, startRequest)),
				),
		},
	},
});
