import { createFileRoute } from "@tanstack/react-router";
import { createProjectRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	createImportProject,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** A new private repository and project for a folder that has none; the CLI pushes to it. */
export const Route = createFileRoute("/api/local-import/create-project")({
	server: {
		handlers: {
			POST: ({ request }) =>
				endpoint(async () => {
					const caller = await requireImportCaller(request);
					return createImportProject(
						caller,
						await readImportJson(request, createProjectRequest),
					);
				}),
		},
	},
});
