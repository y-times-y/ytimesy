/** Where a new account (no project yet) stands, as the page loads. */
export type FirstRunState = {
	readonly githubConnected: boolean;
	readonly modelReady: boolean;
};

export type FirstRunStep = "github" | "repositories" | "model";

/** The step a new account opens at: GitHub, then its repositories, then a model. */
export function firstRunStep(input: {
	readonly githubConnected: boolean;
	readonly projectAdded: boolean;
}): FirstRunStep {
	if (input.projectAdded) return "model";
	return input.githubConnected ? "repositories" : "github";
}
