/** GitHub App linking is independent of application sign-in. */
export function githubAppIdentityMatchesSignIn(
	signedInGithubAccountId: string | undefined,
	connectingGithubUserId: string,
) {
	return (
		signedInGithubAccountId === undefined ||
		signedInGithubAccountId === connectingGithubUserId
	);
}

export function needsGithubSetup(message: string) {
	return /\b(?:re)?connect github\b/i.test(message);
}

/** The setup failure for a user whose GitHub link is gone (the UI offers Connect). */
export const GITHUB_SETUP_MESSAGE = "Connect GitHub to set up this project.";
