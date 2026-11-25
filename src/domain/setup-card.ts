import {
	type EnvironmentBuildView,
	environmentFailureSummary,
} from "./environment-build-progress";
import { needsGithubSetup } from "./github-sign-in";

export type SetupCardState =
	| "queued"
	| "building"
	| "failed"
	| "needs-github"
	| "retrying"
	| "ready";

/** calm: working or done; needs-you: the app's blue question style; failure: a real failure. */
export type SetupCardTone = "calm" | "needs-you" | "failure";

export type SetupCardProgress = "queued" | "building" | "ready";

export type SetupCardInput = {
	readonly status: string;
	readonly errorMessage?: string | null;
	readonly build?: Pick<
		EnvironmentBuildView,
		"status" | "rebuild" | "errorMessage" | "failure"
	> | null;
	/** A retry was asked for and has not shown as running yet. */
	readonly retrying?: boolean;
	/** The setup was queued and never started (workspacePrepareStalled). */
	readonly stalled?: boolean;
};

export type SetupCardModel = {
	readonly state: SetupCardState;
	readonly tone: SetupCardTone;
	readonly title: string;
	/** One plain line, from the real reason. */
	readonly reason: string;
	readonly progress: SetupCardProgress | null;
	/** Whether a details section (steps, output) has anything to show. */
	readonly hasDetails: boolean;
};

const STEP_LABEL: Record<string, string> = {
	provisioning: "Starting the machine",
	cloning: "Cloning the repository",
	installing: "Installing dependencies",
};

/** What the project's setup card says, from the workspace's status and newest build. */
export function setupCard(input: SetupCardInput): SetupCardModel {
	const { status, build } = input;
	if (input.retrying)
		return {
			state: "retrying",
			tone: "calm",
			title: "Trying again",
			reason: "Starting setup over.",
			progress: "queued",
			hasDetails: false,
		};
	if (input.stalled)
		return {
			state: "failed",
			tone: "needs-you",
			title: "Setup didn't start",
			reason: "Setup hasn't started yet.",
			progress: null,
			hasDetails: false,
		};
	const buildRunning = build?.status === "running";
	const failed =
		status === "failed" || (!buildRunning && build?.status === "failed");
	if (failed) {
		const message = build?.errorMessage ?? input.errorMessage ?? null;
		if (message && needsGithubSetup(message))
			return {
				state: "needs-github",
				tone: "needs-you",
				title: "Connect GitHub to continue",
				reason: message,
				progress: null,
				hasDetails: false,
			};
		const failure = build?.failure ?? null;
		return {
			state: "failed",
			tone: "failure",
			title: "Setup didn't finish",
			reason: failure
				? environmentFailureSummary(failure)
				: (message ?? "Setup stopped before it finished."),
			progress: null,
			hasDetails: Boolean(failure?.output) || Boolean(build),
		};
	}
	if (status === "ready" && !buildRunning)
		return {
			state: "ready",
			tone: "calm",
			title: "Environment ready",
			reason: "The project's machine is set up.",
			progress: "ready",
			hasDetails: Boolean(build),
		};
	const rebuilding = Boolean(build?.rebuild) || status === "ready";
	if (status === "queued" && !rebuilding)
		return {
			state: "queued",
			tone: "calm",
			title: "Getting ready to set up",
			reason: "Waiting for a machine.",
			progress: "queued",
			hasDetails: false,
		};
	return {
		state: "building",
		tone: "calm",
		title: rebuilding ? "Updating the environment" : "Setting up your project",
		reason: STEP_LABEL[status] ?? "Preparing the environment",
		progress: "building",
		hasDetails: true,
	};
}
