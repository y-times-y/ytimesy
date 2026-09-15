import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import {
	gitHubProjectCatalog,
	type PublicProjectPicker,
	publicProjectPicker,
} from "#/domain/github-project";
import {
	liveGitHubProjectDeps,
	loadGitHubProjectPicker,
	saveGitHubProjectSelection,
} from "#/server/services/github-projects";

export const getGitHubProjects = createServerFn({ method: "GET" }).handler(
	async (): Promise<PublicProjectPicker> => {
		try {
			return await Effect.runPromise(
				loadGitHubProjectPicker(liveGitHubProjectDeps()),
			);
		} catch (cause) {
			return publicProjectPicker({
				catalog: gitHubProjectCatalog({
					credentialsPresent: true,
					installUrl: null,
					installationCount: 0,
					repositories: [],
					error:
						cause instanceof Error
							? cause.message
							: "GitHub App request failed.",
				}),
				selected: null,
				branches: [],
			});
		}
	},
);

export const saveGitHubProjectSelectionFn = createServerFn({ method: "POST" })
	.validator((data: { projectId: string; branch: string }) => {
		const projectId = data.projectId.trim();
		const branch = data.branch.trim();
		if (!projectId) throw new Error("A project is required");
		if (!branch) throw new Error("A branch is required");
		return { projectId, branch };
	})
	.handler(async ({ data }): Promise<PublicProjectPicker> => {
		return Effect.runPromise(
			saveGitHubProjectSelection(liveGitHubProjectDeps(), data),
		);
	});
