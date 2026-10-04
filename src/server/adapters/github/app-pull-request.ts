import { ensureDraftPullRequest } from "../github";
import { githubInstallationAccessToken } from "./installation-token";

/** Attribute PR creation to the installed app, with permission limited to this repository. */
export async function ensureAppDraftPullRequest(
	installationId: number | string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
) {
	const parts = fullName.split("/");
	if (
		parts.length !== 2 ||
		parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
	)
		throw new Error("Invalid pull request repository.");
	const token = await githubInstallationAccessToken(installationId, {
		repositoryNames: [parts[1]],
		contents: "read",
		pullRequests: "write",
	});
	return ensureDraftPullRequest(token, fullName, draft);
}
