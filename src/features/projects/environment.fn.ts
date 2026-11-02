import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { parseEnvironmentRecipe } from "#/domain/project-environment";
import { repositoriesForProject } from "#/domain/projects";
import { activeEnvironmentSetup } from "#/server/adapters/environment-build-steps";
import {
	environmentRecipeById,
	environmentRecipeHistory,
	latestEnvironmentRecipes,
} from "#/server/adapters/environment-recipes";
import { projectForOwner } from "#/server/adapters/projects";
import { workspaceForProject } from "#/server/adapters/workspaces";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { saveProjectEnvironment } from "#/server/services/project-environment-setup";

const projectInput = z.object({ projectId: z.uuid() });

/** Settings > Project > Environment: each repository's saved setup and the history. */
export const getProjectEnvironmentFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const project = await projectForOwner(user.id, data.projectId);
		if (!project) throw new Error("Project is not available.");
		const [latest, history, workspace] = await Promise.all([
			latestEnvironmentRecipes(user.id, project.id),
			environmentRecipeHistory(user.id, project.id),
			workspaceForProject(user.id, project.id),
		]);
		// What the active environment actually did per repository (detected,
		// the repository's own file, nothing), from its build.
		const setup = workspace ? await activeEnvironmentSetup(workspace.id) : null;
		const repositories = repositoriesForProject(project);
		const name = (repositoryId: number) =>
			repositories.find((repo) => repo.repositoryId === repositoryId)
				?.fullName ?? "Removed repository";
		return {
			repositories: repositories.map((repo) => ({
				repositoryId: repo.repositoryId,
				fullName: repo.fullName,
				saved: latest.get(repo.repositoryId) ?? null,
				setup:
					setup?.find((item) => item.repositoryId === repo.repositoryId) ??
					null,
			})),
			history: history.map((row) => ({
				...row,
				fullName: name(row.repositoryId),
			})),
		};
	});

/** Saves a setup edited by hand (JSON) and rebuilds the project's machine image. */
export const saveProjectEnvironmentFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				projectId: z.uuid(),
				repository: z.string().max(200),
				recipe: z.string().max(65_536),
			})
			.parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		let recipe: ReturnType<typeof parseEnvironmentRecipe>;
		try {
			recipe = parseEnvironmentRecipe(data.recipe);
		} catch (cause) {
			throw new Error(
				cause instanceof Error
					? `That setup isn't valid: ${cause.message}`
					: "That setup isn't valid.",
			);
		}
		const result = await saveProjectEnvironment({
			userId: user.id,
			projectId: data.projectId,
			repository: data.repository,
			recipe,
			source: "user",
			summary: "Edited in Settings",
		});
		return { rebuilding: result.rebuilding };
	});

/** Saves an older setup from History again as the newest, and rebuilds. */
export const restoreProjectEnvironmentFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ projectId: z.uuid(), recipeId: z.uuid() }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		const project = await projectForOwner(user.id, data.projectId);
		if (!project) throw new Error("Project is not available.");
		const old = await environmentRecipeById(user.id, project.id, data.recipeId);
		if (!old) throw new Error("That setup is no longer available.");
		const repository = repositoriesForProject(project).find(
			(repo) => repo.repositoryId === old.repositoryId,
		);
		if (!repository)
			throw new Error("That setup's repository is no longer in the project.");
		const result = await saveProjectEnvironment({
			userId: user.id,
			projectId: project.id,
			repository: repository.fullName,
			recipe: old.recipe,
			source: "user",
			summary: `Restored the setup from ${old.savedAt.slice(0, 10)}`,
		});
		return { rebuilding: result.rebuilding };
	});
