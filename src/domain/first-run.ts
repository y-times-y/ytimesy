/** Where a new account (no project yet) stands, as the page loads. */
export type FirstRunState = {
	readonly githubConnected: boolean;
	readonly modelReady: boolean;
};

/**
 * "install": signed in with GitHub, but the ytimesy app reaches no repository yet.
 * "sessions": optional, bring local coding-agent sessions (the import needs GitHub).
 */
export type FirstRunStep =
	| "github"
	| "install"
	| "repositories"
	| "model"
	| "sessions";

/**
 * The step a new account opens at: GitHub sign-in, the app installed on at
 * least one repository, those repositories, a model, then (optional) local
 * agent sessions. `repositoryCount` is null until the list has loaded; the
 * model and sessions steps can be skipped, so neither blocks finishing.
 */
export function firstRunStep(input: {
	readonly githubConnected: boolean;
	readonly repositoryCount: number | null;
	readonly projectAdded: boolean;
	/** The model step was passed (chosen or Later), or a model was ready already. */
	readonly modelDone?: boolean;
}): FirstRunStep {
	if (input.projectAdded)
		return input.modelDone && input.githubConnected ? "sessions" : "model";
	if (!input.githubConnected) return "github";
	return input.repositoryCount === 0 ? "install" : "repositories";
}

/** The stages the progress bar shows; installing the app is part of GitHub. */
export const FIRST_RUN_STAGES = [
	"github",
	"repositories",
	"model",
	"sessions",
] as const;

export function firstRunStage(step: FirstRunStep) {
	return FIRST_RUN_STAGES.indexOf(step === "install" ? "github" : step);
}
