/** Why connecting the ytimesy GitHub App did not finish, passed back to the
 * app as `?connection=<reason>` so the user sees what to do next. */
export const githubConnectionFailureReasons = [
	"denied",
	"expired",
	"wrong-account",
	"failed",
] as const;
export type GithubConnectionFailureReason =
	(typeof githubConnectionFailureReasons)[number];

export function githubConnectionFailureReason(
	value: string | null | undefined,
): GithubConnectionFailureReason | null {
	if (!value) return null;
	return (githubConnectionFailureReasons as readonly string[]).includes(value)
		? (value as GithubConnectionFailureReason)
		: "failed";
}

export function githubConnectionFailureMessage(
	reason: GithubConnectionFailureReason,
): string {
	switch (reason) {
		case "denied":
			return "GitHub access was canceled. Connect GitHub again when you're ready.";
		case "expired":
			return "The GitHub connection took too long and expired. Connect GitHub again.";
		case "wrong-account":
			return "That GitHub account isn't the one you signed in with. Switch to that account on github.com, then connect again.";
		case "failed":
			return "GitHub could not be connected. Try again in a moment.";
	}
}
