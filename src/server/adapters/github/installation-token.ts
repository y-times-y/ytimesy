import { Effect } from "effect";
import { readGitHubAppCredentials } from "./credentials";
import { createOctokitGitHubListing } from "./octokit-app";

export async function githubInstallationAccessToken(
	installationId: number | string,
	scope?: { repositoryNames: string[]; contents: "read" | "write" },
) {
	const credentials = await Effect.runPromise(readGitHubAppCredentials());
	return createOctokitGitHubListing().installationToken({
		credentials,
		installationId: String(installationId),
		...scope,
	});
}
