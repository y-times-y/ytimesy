import { Effect } from "effect";
import { readGitHubAppCredentials } from "./credentials";
import { createOctokitGitHubListing } from "./octokit-app";

type InstallationTokenScope = {
	repositoryNames: string[];
	contents?: "read" | "write";
	pullRequests?: "read" | "write";
	checks?: "read";
	actions?: "read";
};

/**
 * GitHub's installation tokens live an hour. One minted for an installation
 * and scope is reused (per isolate) for this long, so a push's two Git
 * requests and the pull request after it do not each mint and sign another.
 */
export const INSTALLATION_TOKEN_REUSE_MS = 30 * 60_000;
const MAX_TOKENS = 200;
const tokens = new Map<
	string,
	{ readonly token: Promise<string>; readonly expiresAt: number }
>();

export async function githubInstallationAccessToken(
	installationId: number | string,
	scope?: InstallationTokenScope,
) {
	const key = JSON.stringify([
		String(installationId),
		scope ? [...scope.repositoryNames].sort() : null,
		scope?.contents ?? null,
		scope?.pullRequests ?? null,
		scope?.checks ?? null,
		scope?.actions ?? null,
	]);
	const now = Date.now();
	const cached = tokens.get(key);
	if (cached && cached.expiresAt > now) return cached.token;
	tokens.delete(key);
	for (const [entry, { expiresAt }] of tokens)
		if (expiresAt <= now) tokens.delete(entry);
	while (tokens.size >= MAX_TOKENS) {
		const oldest = tokens.keys().next().value;
		if (oldest === undefined) break;
		tokens.delete(oldest);
	}
	const token = mintInstallationToken(installationId, scope);
	tokens.set(key, { token, expiresAt: now + INSTALLATION_TOKEN_REUSE_MS });
	// A failed mint is never reused: the next call asks GitHub again.
	token.catch(() => {
		if (tokens.get(key)?.token === token) tokens.delete(key);
	});
	return token;
}

/** Drops reused tokens: all of them, or one installation's (e.g. after GitHub refused one). */
export function forgetInstallationTokens(installationId?: number | string) {
	if (installationId === undefined) return tokens.clear();
	for (const key of tokens.keys())
		if (JSON.parse(key)[0] === String(installationId)) tokens.delete(key);
}

async function mintInstallationToken(
	installationId: number | string,
	scope?: InstallationTokenScope,
) {
	const credentials = await Effect.runPromise(readGitHubAppCredentials());
	return createOctokitGitHubListing().installationToken({
		credentials,
		installationId: String(installationId),
		...scope,
	});
}
