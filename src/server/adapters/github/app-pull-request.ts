import { randomUUID } from "node:crypto";
import { pullRequestFixPath, withFixSection } from "#/domain/pull-request-wake";
import { ensureDraftPullRequest } from "../github";
import { recordPullRequestLink } from "../pull-request-links";
import { githubInstallationAccessToken } from "./installation-token";

/** The project chat a pull request is opened for; it can then start or wake that chat. */
export type PullRequestOrigin = {
	userId: string;
	projectId: string;
	repositoryId: number | string;
	sessionId: string | null;
};

/**
 * Attribute PR creation to the installed app, with permission limited to this
 * repository. With an origin, a new PR's description links to "Fix with
 * ytimesy" and the PR is recorded as the project's, so GitHub events on it
 * (failed checks, @ytimesy comments) can wake its chat.
 */
export async function ensureAppDraftPullRequest(
	installationId: number | string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
	origin?: PullRequestOrigin,
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
	const linkId = randomUUID();
	const app = process.env.APP_URL?.replace(/\/+$/, "");
	const body =
		origin && app
			? withFixSection(
					draft.body,
					`${app}${pullRequestFixPath(origin.projectId, linkId)}`,
				)
			: draft.body;
	const pull = await ensureDraftPullRequest(token, fullName, {
		...draft,
		body,
	});
	if (origin && "number" in pull && typeof pull.number === "number")
		await recordPullRequestLink({
			id: linkId,
			userId: origin.userId,
			projectId: origin.projectId,
			installationId,
			repositoryId: origin.repositoryId,
			fullName,
			pullNumber: pull.number,
			headRef: draft.head,
			baseRef: draft.base,
			originSessionId: origin.sessionId,
		}).catch((error) =>
			// The pull request stands; only its GitHub wake-ups are unavailable.
			console.warn("Pull request link could not be recorded.", {
				message:
					error instanceof Error ? error.message.slice(0, 300) : "unknown",
			}),
		);
	return pull;
}
