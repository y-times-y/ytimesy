import type { PublicationAuthor } from "#/domain/publication";
import { githubCommitIdentityForToken } from "../adapters/github/commit-identity";
import { githubAccessToken } from "../auth/github-connection";

/**
 * The signed-in user's own GitHub identity, taken from their connected
 * account (never guessed), so their commits count as their contributions.
 * Null when GitHub did not identify them or could not be reached: commits
 * then keep the bot as author instead of failing the user's action.
 */
export function managedGitAuthorForUser(
	userId: string | undefined,
): Promise<PublicationAuthor | null> {
	if (!userId) return Promise.resolve(null);
	return githubAccessToken(userId)
		.then(githubCommitIdentityForToken)
		.catch(() => null);
}
