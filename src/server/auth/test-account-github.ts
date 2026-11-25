import { TEST_ACCOUNT_ID } from "#/domain/test-account";
import { database } from "../adapters/database";
import { githubInstallationAccessToken } from "../adapters/github/installation-token";

/** The only repository the synthetic account may read (docs/testing-live.md). */
export const TEST_ACCOUNT_REPOSITORY = {
	owner: "y-times-y",
	name: "ytimesy",
} as const;

type Deps = {
	lookup: () => Promise<number | null>;
	mint: (
		installationId: number,
		scope: { repositoryNames: string[]; contents: "read" },
	) => Promise<string>;
};

const defaults: Deps = {
	lookup: async () => {
		const row = (
			await database().query<{ id: string }>(
				"select installation_id::text as id from project where full_name=$1 and user_id<>$2 order by created_at limit 1",
				[
					`${TEST_ACCOUNT_REPOSITORY.owner}/${TEST_ACCOUNT_REPOSITORY.name}`,
					TEST_ACCOUNT_ID,
				],
			)
		).rows[0];
		return row ? Number(row.id) : null;
	},
	mint: githubInstallationAccessToken,
};

/**
 * Stands in for a signed-in user's GitHub token, for the synthetic account
 * only: an installation token (one hour, never stored or printed) limited to
 * the seed repository with read-only contents. null for everyone else.
 */
export async function testAccountGithubToken(
	userId: string,
	deps: Deps = defaults,
): Promise<string | null> {
	if (userId !== TEST_ACCOUNT_ID) return null;
	const installationId = await deps.lookup();
	if (!installationId)
		throw new Error("The seed repository has no installation.");
	return deps.mint(installationId, {
		repositoryNames: [TEST_ACCOUNT_REPOSITORY.name],
		contents: "read",
	});
}
