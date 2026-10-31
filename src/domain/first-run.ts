/** Where a new account (no project yet) stands, as the page loads. */
export type FirstRunState = {
	readonly githubConnected: boolean;
	readonly modelReady: boolean;
};

/** "install": signed in with GitHub, but the ytimesy app reaches no repository yet. */
export type FirstRunStep = "github" | "install" | "repositories" | "model";

/**
 * The step a new account opens at: GitHub sign-in, the app installed on at
 * least one repository, those repositories, then a model. `repositoryCount`
 * is null until the list has loaded.
 */
export function firstRunStep(input: {
	readonly githubConnected: boolean;
	readonly repositoryCount: number | null;
	readonly projectAdded: boolean;
}): FirstRunStep {
	if (input.projectAdded) return "model";
	if (!input.githubConnected) return "github";
	return input.repositoryCount === 0 ? "install" : "repositories";
}

/** The three stages the progress bar shows; installing the app is part of GitHub. */
export const FIRST_RUN_STAGES = ["github", "repositories", "model"] as const;

export function firstRunStage(step: FirstRunStep) {
	return FIRST_RUN_STAGES.indexOf(step === "install" ? "github" : step);
}
