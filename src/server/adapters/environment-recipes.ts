import {
	type EnvironmentRecipe,
	environmentRecipe,
} from "#/domain/project-environment";
import { database } from "./database";

export type EnvironmentRecipeSource = "agent" | "user" | "import";

export type SavedEnvironmentRecipe = {
	readonly id: string;
	readonly repositoryId: number;
	readonly recipe: EnvironmentRecipe;
	readonly source: EnvironmentRecipeSource;
	readonly summary: string | null;
	readonly savedAt: string;
};

type Row = {
	id: string;
	repository_id: string | number;
	recipe: unknown;
	source: EnvironmentRecipeSource;
	summary: string | null;
	created_at: Date;
};

function fromRow(row: Row): SavedEnvironmentRecipe | null {
	const recipe = environmentRecipe.safeParse(row.recipe);
	if (!recipe.success) return null;
	return {
		id: row.id,
		repositoryId: Number(row.repository_id),
		recipe: recipe.data,
		source: row.source,
		summary: row.summary,
		savedAt: row.created_at.toISOString(),
	};
}

/** Saves a new version of one repository's setup; the owner check is in the insert. */
export async function saveEnvironmentRecipe(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly repositoryId: number;
	readonly recipe: EnvironmentRecipe;
	readonly source: EnvironmentRecipeSource;
	readonly summary?: string | null;
}): Promise<SavedEnvironmentRecipe> {
	const result = await database().query<Row>(
		`insert into project_environment_recipe(project_id,user_id,repository_id,recipe,source,summary)
		 select p.id, p.user_id, $3, $4::jsonb, $5, $6 from project p
		 where p.id=$1 and p.user_id=$2
		 returning id, repository_id, recipe, source, summary, created_at`,
		[
			input.projectId,
			input.userId,
			input.repositoryId,
			JSON.stringify(input.recipe),
			input.source,
			input.summary?.trim().slice(0, 300) || null,
		],
	);
	const saved = result.rows[0] && fromRow(result.rows[0]);
	if (!saved) throw new Error("Project is not available.");
	return saved;
}

/** Each repository's newest saved setup. */
export async function latestEnvironmentRecipes(
	userId: string,
	projectId: string,
): Promise<Map<number, SavedEnvironmentRecipe>> {
	const result = await database().query<Row>(
		`select distinct on (repository_id) id, repository_id, recipe, source, summary, created_at
		 from project_environment_recipe where project_id=$1 and user_id=$2
		 order by repository_id, created_at desc`,
		[projectId, userId],
	);
	return new Map(
		result.rows.flatMap((row) => {
			const saved = fromRow(row);
			return saved ? [[saved.repositoryId, saved] as const] : [];
		}),
	);
}

/** The project's saved setups, newest first, for Settings' history. */
export async function environmentRecipeHistory(
	userId: string,
	projectId: string,
	limit = 20,
): Promise<SavedEnvironmentRecipe[]> {
	const result = await database().query<Row>(
		`select id, repository_id, recipe, source, summary, created_at
		 from project_environment_recipe where project_id=$1 and user_id=$2
		 order by created_at desc limit $3`,
		[projectId, userId, limit],
	);
	return result.rows.flatMap((row) => {
		const saved = fromRow(row);
		return saved ? [saved] : [];
	});
}
