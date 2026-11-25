import { Effect } from "effect";
import { TEST_ACCOUNT_ID } from "#/domain/test-account";
import { githubClient } from "../adapters/github";
import { readGitHubAppCredentials } from "../adapters/github/credentials";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";
import { createOctokitGitHubListing } from "../adapters/github/octokit-app";
import { listModelConnections } from "../adapters/model-connections";
import { saveProject } from "../adapters/projects";
import { connectApiModels } from "./model-connections";
import type { TestAccountDb } from "./test-account";
import { enqueueProjectWorkspace } from "./workspaces";
import { createProjectYSquared } from "./y-on-add";

/** The one repository the synthetic account may be given (the canary's, docs/interruption-monitoring.md). */
export const SEED_REPOSITORY = "y-times-y/ytimesy";
export const SEED_MODEL_LABEL = "Test account model";

/** The seed repository among what the installation lists: GitHub's current id, not a stored one that a rename may have left behind. */
export function pickSeedRepository<
	T extends { id: number; full_name: string; archived?: boolean },
>(repositories: readonly T[]) {
	return repositories.find(
		(repo) =>
			repo.full_name.toLowerCase() === SEED_REPOSITORY && !repo.archived,
	);
}

/** Aggregate only: no ids, names or user data leave the database. */
export async function yDefaultCounts(db: TestAccountDb) {
	const row = (
		await db.query<{ on: string; off: string }>(
			`select count(*) filter (where y_enabled)::text as "on",
			        count(*) filter (where not y_enabled)::text as "off"
			 from project where archived_at is null`,
		)
	).rows[0];
	return { yOn: Number(row?.on ?? 0), yOff: Number(row?.off ?? 0) };
}

/**
 * Gives the test account what a first run needs and it cannot get through
 * GitHub sign-in: a model connection (the key arrives in the request body and
 * is sealed by the normal connection path, never logged) and one project for
 * the seed repository. Only the repository's and installation's numeric ids
 * are copied from the existing project of that repository; the test user gets
 * its own project row, workspace and Y².
 */
export async function seedTestAccount(
	db: TestAccountDb,
	userId: string,
	input: { apiKey?: string },
) {
	if (userId !== TEST_ACCOUNT_ID) throw new Error("not the test account");
	let modelConnected = (await listModelConnections(userId)).length > 0;
	if (!modelConnected && input.apiKey) {
		await Effect.runPromise(
			connectApiModels(userId, {
				provider: "anthropic",
				label: SEED_MODEL_LABEL,
				apiKey: input.apiKey,
			}),
		);
		modelConnected = true;
	}
	const source = (
		await db.query<{ repository_id: string; installation_id: string }>(
			"select repository_id::text, installation_id::text from project where full_name=$1 and user_id<>$2 order by created_at limit 1",
			[SEED_REPOSITORY, userId],
		)
	).rows[0];
	if (!source) return { modelConnected, projectId: null };
	const installationId = Number(source.installation_id);
	const token = await githubInstallationAccessToken(installationId, {
		repositoryNames: [SEED_REPOSITORY.split("/")[1] as string],
		contents: "read",
	});
	const github = githubClient(token);
	const listed = pickSeedRepository(
		await github.paginate(github.apps.listReposAccessibleToInstallation, {
			per_page: 100,
		}),
	);
	if (!listed)
		throw new Error("The installation does not list the seed repository.");
	const project = await saveProject(
		userId,
		{
			repositoryId: listed.id,
			installationId,
			fullName: listed.full_name,
			defaultBranch: listed.default_branch,
			private: listed.private,
		},
		listed.default_branch,
	);
	await Effect.runPromise(enqueueProjectWorkspace(userId, project.id));
	const ySquaredId = await createProjectYSquared(userId, project.id);
	return { modelConnected, projectId: project.id, ySquaredId };
}

/**
 * Ids only, for the one seed repository: which repository ids the projects
 * of that name store, and the id GitHub lists for it under each installation.
 * No project, user or content data leaves the database.
 */
export async function seedRepositoryIds(db: TestAccountDb) {
	const stored = (
		await db.query<{
			repository_id: string;
			installation_id: string;
			archived: boolean;
			n: string;
		}>(
			`select repository_id::text, installation_id::text, archived_at is not null as archived, count(*)::text as n
			 from project where full_name=$1 group by 1,2,3 order by 1,2,3`,
			[SEED_REPOSITORY],
		)
	).rows.map((row) => ({
		repositoryId: Number(row.repository_id),
		installationId: Number(row.installation_id),
		archived: row.archived,
		projects: Number(row.n),
	}));
	const groupRows = (
		await db.query<{
			repository_id: string;
			installation_id: string;
			n: string;
		}>(
			`select r.repository_id::text, r.installation_id::text, count(*)::text as n
			 from project_repository r where r.full_name=$1 group by 1,2 order by 1,2`,
			[SEED_REPOSITORY],
		)
	).rows.map((row) => ({
		repositoryId: Number(row.repository_id),
		installationId: Number(row.installation_id),
		rows: Number(row.n),
	}));
	const listed: Record<string, number | null> = {};
	for (const installationId of new Set(
		stored.map((row) => row.installationId),
	)) {
		try {
			const token = await githubInstallationAccessToken(installationId, {
				repositoryNames: [SEED_REPOSITORY.split("/")[1] as string],
				contents: "read",
			});
			const github = githubClient(token);
			listed[String(installationId)] =
				pickSeedRepository(
					await github.paginate(github.apps.listReposAccessibleToInstallation, {
						per_page: 100,
					}),
				)?.id ?? null;
		} catch {
			listed[String(installationId)] = null;
		}
	}
	// Names and ids of what the seed installation lists (organisation repositories, no content).
	const installations = [...new Set(stored.map((row) => row.installationId))];
	const everything: { id: number; fullName: string }[] = [];
	for (const installationId of installations.slice(0, 1)) {
		try {
			const token = await createOctokitGitHubListing().installationToken({
				credentials: await Effect.runPromise(readGitHubAppCredentials()),
				installationId: String(installationId),
				contents: "read",
			});
			const github = githubClient(token);
			for (const repo of await github.paginate(
				github.apps.listReposAccessibleToInstallation,
				{ per_page: 100 },
			))
				everything.push({ id: repo.id, fullName: repo.full_name });
		} catch (error) {
			everything.push({
				id: 0,
				fullName: `error: ${String(error).slice(0, 80)}`,
			});
		}
	}
	return { stored, groupRows, listed, installationRepositories: everything };
}
