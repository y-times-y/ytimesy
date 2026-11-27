/**
 * GitHub is connected through ytimesy (the edge holds its credentials), so an
 * agent never needs a GitHub token, and a project secret for one would only
 * put a credential on the machine that must hold none. Requests and saves for
 * one are refused with this text instead of showing the user a card.
 */
export const GITHUB_CREDENTIAL_REFUSAL =
	"GitHub is connected; push the branch; the platform opens the pull request at the end of the turn.";

const GITHUB_TOKEN_NAME =
	/^(?:GH|GITHUB)(?:_[A-Z0-9]+)*_(?:TOKEN|PAT)$|^GITHUB_TOKEN$/i;
const GITHUB_CLI_LOGIN = /\bgh\s+auth\b/;

/** `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PAT` and the like. */
export function isGithubCredentialName(name: string) {
	return GITHUB_TOKEN_NAME.test(name.trim());
}

/** A command that prints or sets up the GitHub CLI's login (`gh auth token`). */
export function isGithubCliAuth(command: string) {
	return GITHUB_CLI_LOGIN.test(command);
}
