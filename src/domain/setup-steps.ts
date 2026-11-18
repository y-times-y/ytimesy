import type { FirstRunState } from "./first-run";

/** The things a new account sets up while it uses the app, in order. */
export type SetupStepId = "github" | "model" | "sessions";
export type SetupStepStatus = "done" | "current" | "todo" | "skipped";

export type SetupStep = {
	readonly id: SetupStepId;
	readonly status: SetupStepStatus;
	/** Sessions can be skipped; GitHub and a model cannot. */
	readonly optional: boolean;
};

export type SetupProgress = {
	readonly steps: readonly SetupStep[];
	/** Steps finished or skipped. */
	readonly settled: number;
	/** The step to do next; null when every step is settled. */
	readonly current: SetupStepId | null;
	readonly complete: boolean;
};

/**
 * Where setup stands. GitHub counts as done once the ytimesy app reaches at
 * least one repository (signing in alone reaches none). Importing sessions
 * is optional and only needs GitHub; it is settled when imported or skipped.
 */
export function setupProgress(input: {
	readonly state: Pick<FirstRunState, "githubConnected" | "modelReady">;
	/** Repositories the app reaches; null until the list has loaded. */
	readonly repositoryCount: number | null;
	readonly sessionsSkipped: boolean;
}): SetupProgress {
	const githubDone =
		input.state.githubConnected && (input.repositoryCount ?? 0) > 0;
	const done: Record<SetupStepId, boolean> = {
		github: githubDone,
		model: input.state.modelReady,
		sessions: input.sessionsSkipped,
	};
	const order: readonly SetupStepId[] = ["github", "model", "sessions"];
	const current = order.find((id) => !done[id]) ?? null;
	const steps = order.map((id): SetupStep => {
		const optional = id === "sessions";
		const status: SetupStepStatus =
			id === "sessions" && done.sessions
				? "skipped"
				: done[id]
					? "done"
					: id === current
						? "current"
						: "todo";
		return { id, status, optional };
	});
	return {
		steps,
		settled: steps.filter((s) => s.status === "done" || s.status === "skipped")
			.length,
		current,
		complete: current === null,
	};
}
