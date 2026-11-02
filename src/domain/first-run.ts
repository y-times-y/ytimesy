/** Where a new account (no project yet) stands, as the page loads. */
export type FirstRunState = {
	readonly githubConnected: boolean;
	readonly modelReady: boolean;
	/** SuperGrok sign-in is offered (its feature switch is on). */
	readonly xaiSubscription?: boolean;
};

/**
 * "install": signed in with GitHub, but the ytimesy app reaches no repository yet.
 * "sessions": optional, bring local coding-agent sessions (the import needs GitHub).
 * There is no repository step: the composer's project picker adds the first
 * project, and an import makes the projects its sessions need.
 */
export type FirstRunStep = "github" | "install" | "model" | "sessions";

/**
 * The step a new account opens at: GitHub sign-in and the app installed on
 * at least one repository, then a model, then (optional) local agent
 * sessions. `repositoryCount` is null until the list has loaded: the GitHub
 * step stays until then, so the install is not asked for too early. The
 * model and sessions steps can be skipped, so neither blocks finishing.
 */
export function firstRunStep(input: {
	readonly githubConnected: boolean;
	readonly repositoryCount: number | null;
	/** The model step was passed (chosen or Later), or a model was ready already. */
	readonly modelDone?: boolean;
}): FirstRunStep {
	if (!input.githubConnected) return "github";
	if (input.repositoryCount === null) return "github";
	if (input.repositoryCount === 0) return "install";
	return input.modelDone ? "sessions" : "model";
}

/** The stages the progress bar shows; installing the app is part of GitHub. */
export const FIRST_RUN_STAGES = ["github", "model", "sessions"] as const;

export function firstRunStage(step: FirstRunStep) {
	return FIRST_RUN_STAGES.indexOf(step === "install" ? "github" : step);
}

/**
 * Set when the user leaves the first run (Continue on the last step): the
 * page then opens the workspace even while the account has no project yet,
 * and the composer's project picker adds the first one. It holds the user id,
 * so another account signing in on the same browser still gets its first run.
 */
export const FIRST_RUN_DONE_COOKIE = "ytimesy-setup-done";

export function firstRunDoneCookie(userId: string) {
	return `${FIRST_RUN_DONE_COOKIE}=${encodeURIComponent(userId)}; path=/; max-age=31536000; samesite=lax`;
}

/** Whether this user already left the first run in this browser. */
export function firstRunDoneFromCookies(
	header: string | null | undefined,
	userId: string,
) {
	const raw = header
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${FIRST_RUN_DONE_COOKIE}=`))
		?.slice(FIRST_RUN_DONE_COOKIE.length + 1);
	if (!raw) return false;
	try {
		return decodeURIComponent(raw) === userId;
	} catch {
		return false;
	}
}
