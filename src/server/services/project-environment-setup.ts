import type { EnvironmentRecipe } from "#/domain/project-environment";
import { repositoriesForProject } from "#/domain/projects";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../adapters/background-job-dispatch";
import {
	type EnvironmentRecipeSource,
	saveEnvironmentRecipe,
} from "../adapters/environment-recipes";
import { projectForOwner } from "../adapters/projects";
import { readySetupCatchUps } from "../adapters/setup-catch-up";
import { workspaceForProject } from "../adapters/workspaces";

/**
 * Saves a repository's environment setup (Settings > Project > Environment)
 * and rebuilds the project's machine image from it in the background; chats
 * keep using the current image until the new one is ready.
 */
export async function saveProjectEnvironment(input: {
	readonly userId: string;
	readonly projectId: string;
	/** "owner/name"; may be left out when the project has one repository. */
	readonly repository?: string | null;
	readonly recipe: EnvironmentRecipe;
	readonly source: EnvironmentRecipeSource;
	readonly summary?: string | null;
	/** The chat whose agent saved it (it set the project up itself). */
	readonly savedInSessionId?: string;
}) {
	const project = await projectForOwner(input.userId, input.projectId);
	if (!project) throw new Error("Project is not available.");
	const repositories = repositoriesForProject(project);
	const wanted = input.repository?.trim().toLowerCase();
	const repository = wanted
		? repositories.find((repo) => repo.fullName.toLowerCase() === wanted)
		: repositories.length === 1
			? repositories[0]
			: undefined;
	if (!repository)
		throw new Error(
			`Name the repository: one of ${repositories.map((repo) => repo.fullName).join(", ")}.`,
		);
	const saved = await saveEnvironmentRecipe({
		userId: input.userId,
		projectId: input.projectId,
		repositoryId: repository.repositoryId,
		recipe: input.recipe,
		source: input.source,
		summary: input.summary,
	});
	const workspace = await workspaceForProject(input.userId, input.projectId);
	const rebuilding = workspace
		? await dispatchBackgroundJob({
				id: backgroundJobId(`environment-recipe:${saved.id}`),
				kind: "prepare",
				workspaceId: workspace.id,
				force: false,
				repairModel: null,
			}).catch(() => false)
		: false;
	// Chats that started before the project had a template catch up at their
	// next model step (fresh-machine-setup.ts); a failure here only skips that.
	await readySetupCatchUps({
		userId: input.userId,
		projectId: input.projectId,
		savedInSessionId: input.savedInSessionId,
	}).catch((error: unknown) =>
		console.warn("Chats could not be told the project's setup finished.", {
			message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		}),
	);
	return { saved, repository: repository.fullName, rebuilding };
}
