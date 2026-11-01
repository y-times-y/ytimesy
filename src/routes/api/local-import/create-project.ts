import { createFileRoute } from "@tanstack/react-router";
import { createProjectRequest } from "#/domain/local-import";
import { endpoint } from "#/server/http";
import {
	createImportProject,
	requireImportCaller,
} from "#/server/services/local-import";
import { readImportJson } from "#/server/services/local-import-http";

/** A project for a repository the ytimesy app reaches (the plan's new project, or one the CLI created with gh). */
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
