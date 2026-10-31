import { githubCommitIdentity } from "#/domain/github-commit-identity";
import { githubClient } from "../github";

/** The signed-in user's GitHub name and email, or null when GitHub did not identify them. */
export async function githubCommitIdentityForToken(token: string) {
	const profile = await githubClient(token).users.getAuthenticated();
	return githubCommitIdentity({
		login: profile.data.login,
		id: profile.data.id,
		name: profile.data.name,
		email: profile.data.email,
	});
}
