import type { FirstRunState } from "./first-run";

/** The things a new account sets up while it uses the app, in order. */
export type SetupStepId = "github" | "model" | "sessions";
export type SetupStepStatus = "done" | "current" | "todo" | "skipped";

export type SetupStep = {
	readonly id: SetupStepId;
	readonly status: SetupStepStatus;
	/** Sessions can be skipped, and never hold setup open; GitHub and a model are required. */
	readonly optional: boolean;
};

export type SetupProgress = {
	readonly steps: readonly SetupStep[];
	/** Required steps finished. */
	readonly settled: number;
	/** Required steps in all (the optional import is not counted). */
	readonly total: number;
	/** The step to do next; null when every step is settled. */
	readonly current: SetupStepId | null;
	/** GitHub and a model are done: the card is no longer needed. */
	readonly complete: boolean;
};

/**
 * Where setup stands. GitHub counts as done once the ytimesy app reaches at
 * least one repository (signing in alone reaches none). Importing sessions
 * is optional: it is shown while setup is open and can be skipped, but it
 * never keeps the card on screen once GitHub and a model are done.
 */
export function setupProgress(input: {
	readonly state: Pick<FirstRunState, "githubConnected" | "modelReady">;
	/** Repositories the app reaches; null until the list has loaded. */
	readonly repositoryCount: number | null;
	readonly sessionsSkipped: boolean;
}): SetupProgress {
	const done: Record<SetupStepId, boolean> = {
		github: input.state.githubConnected && (input.repositoryCount ?? 0) > 0,
		model: input.state.modelReady,
		sessions: input.sessionsSkipped,
	};
	const order: readonly SetupStepId[] = ["github", "model", "sessions"];
	const current = order.find((id) => !done[id]) ?? null;
	const steps = order.map((id): SetupStep => {
		const status: SetupStepStatus =
			id === "sessions" && done.sessions
				? "skipped"
				: done[id]
					? "done"
					: id === current
						? "current"
						: "todo";
		return { id, status, optional: id === "sessions" };
	});
	const required = steps.filter((step) => !step.optional);
	const settled = required.filter((step) => step.status === "done").length;
	return {
		steps,
		settled,
		total: required.length,
		current,
		complete: settled === required.length,
	};
}
