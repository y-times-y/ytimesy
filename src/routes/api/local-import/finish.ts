import { createFileRoute } from "@tanstack/react-router";
import { finishRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	finishImport,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** Opens the continued session's chat on the pushed branch; no turn starts. */
export const Route = createFileRoute("/api/local-import/finish")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request, {
						finished: true,
					});
					return finishImport(
						caller,
						await readImportJson(request, finishRequest),
					);
				}),
		},
	},
});
