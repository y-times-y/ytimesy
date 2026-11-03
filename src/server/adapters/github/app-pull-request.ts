import { randomUUID } from "node:crypto";
import { githubAppMention } from "#/domain/github-bot";
import { withPullRequestFooter } from "#/domain/pull-request-footer";
import { chatPath, pullRequestFixPath } from "#/domain/pull-request-wake";
import { ensureDraftPullRequest, type FoundPullRequest } from "../github";
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
 * Opens or updates the draft pull request as the signed-in user: GitHub sets
 * the author to whoever the token authenticates as. Without a user token the
 * installed app opens it instead, so the work still ships under the app's
 * name. With an origin, the description links to "Fix with ytimesy", names
 * the App's handle (`@<slug>`) and the pull request is recorded for GitHub
 * wake-ups. Every description ends with one "Generated with ytimesy" line.
 */
export async function ensureAppDraftPullRequest(
	installationId: number | string,
	fullName: string,
	draft: { title: string; body: string; head: string; base: string },
	origin?: PullRequestOrigin,
	userAccessToken?: string,
	/** A lookup of the open pull request already under way (with the same user token). */
	existing?: Promise<FoundPullRequest | null>,
) {
	const parts = fullName.split("/");
	if (
		parts.length !== 2 ||
		parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))
	)
		throw new Error("Invalid pull request repository.");
	let token = userAccessToken?.trim() ?? "";
	if (!token) {
		console.warn(
			"Signed-in GitHub token unavailable; opening the pull request as the GitHub App.",
		);
		token = await githubInstallationAccessToken(installationId, {
			repositoryNames: [parts[1]],
			contents: "read",
			pullRequests: "write",
		});
	}
	const linkId = randomUUID();
	const app = process.env.APP_URL?.replace(/\/+$/, "");
	// One footer at the end: how to ask for a change (only when the pull
	// request is recorded, so a comment can wake its chat) and "Generated with
	// ytimesy", linking the chat when there is one.
	const body = withPullRequestFooter(draft.body, {
		fixUrl:
			origin && app
				? `${app}${pullRequestFixPath(origin.projectId, linkId)}`
				: null,
		mention: origin ? githubAppMention(process.env.GITHUB_APP_SLUG) : null,
		chatUrl:
			origin?.sessionId && app
				? `${app}${chatPath(origin.projectId, origin.sessionId)}`
				: null,
	});
	const lookup = userAccessToken?.trim() ? existing : undefined;
	const pull = lookup
		? await ensureDraftPullRequest(token, fullName, { ...draft, body }, lookup)
		: await ensureDraftPullRequest(token, fullName, { ...draft, body });
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
