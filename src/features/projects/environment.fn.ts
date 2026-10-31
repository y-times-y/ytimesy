import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { parseEnvironmentRecipe } from "#/domain/project-environment";
import { repositoriesForProject } from "#/domain/projects";
import {
	environmentRecipeHistory,
	latestEnvironmentRecipes,
} from "#/server/adapters/environment-recipes";
import { projectForOwner } from "#/server/adapters/projects";
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
		const [latest, history] = await Promise.all([
			latestEnvironmentRecipes(user.id, project.id),
			environmentRecipeHistory(user.id, project.id),
		]);
		const repositories = repositoriesForProject(project);
		const name = (repositoryId: number) =>
			repositories.find((repo) => repo.repositoryId === repositoryId)
				?.fullName ?? "Removed repository";
		return {
			repositories: repositories.map((repo) => ({
				repositoryId: repo.repositoryId,
				fullName: repo.fullName,
				saved: latest.get(repo.repositoryId) ?? null,
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
