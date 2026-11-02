import {
	type QueryClient,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import type { TrainingConsent } from "#/domain/training-consent";
import {
	cacheWrite,
	optimisticMutation,
	saveErrorMessage,
} from "#/lib/optimistic-mutation";
import { SettingsSwitch } from "./settings-switch";
import {
	readProjectTrainingFn,
	readTrainingConsentFn,
	saveProjectTrainingFn,
	saveTrainingConsentFn,
} from "./training-consent.fn";

export const CONSENT_KEY = ["training-consent"];

/** The account switch moves at once; the server's record replaces it. */
export function trainingConsentChange(
	queryClient: QueryClient,
	save: (input: {
		data: { enabled: boolean; policyVersion: string };
	}) => Promise<TrainingConsent>,
) {
	return {
		mutationFn: (enabled: boolean) =>
			save({ data: { enabled, policyVersion: TRAINING_POLICY_VERSION } }),
		...optimisticMutation<TrainingConsent, boolean>({
			queryClient,
			scope: "training-consent",
			writes: (enabled) => [
				cacheWrite<TrainingConsent>(CONSENT_KEY, (current) => ({
					...current,
					enabled,
				})),
			],
			serverWrites: (data) => [{ queryKey: CONSENT_KEY, data }],
		}),
	};
}

/** "Never use this project for training" moves at once. */
export function projectTrainingChange(
	queryClient: QueryClient,
	projectId: string,
	save: (input: {
		data: { projectId: string; excluded: boolean };
	}) => Promise<{ excluded: boolean }>,
) {
	const queryKey = ["project-training", projectId];
	return {
		mutationFn: (excluded: boolean) => save({ data: { projectId, excluded } }),
		...optimisticMutation<{ excluded: boolean }, boolean>({
			queryClient,
			scope: `project-training:${projectId}`,
			writes: (excluded) => [
				cacheWrite<{ excluded: boolean }>(queryKey, (current) => ({
					...current,
					excluded,
				})),
			],
			serverWrites: (data) => [{ queryKey, data }],
		}),
	};
}

/** Every commitment the setting makes; shown as the "Learn more" link's tooltip. */
export const TRAINING_DETAILS =
	"Let ytimesy use your chats from now on, including your prompts, your code and its results (such as test output and merged pull requests), to improve our agents and train our own models. We never use replies or code written by AI models. We never share it with model providers. Your stored API keys, secrets and your attachments are never included. Nothing is copied out for training yet. Turn this off any time; it stops immediately, for earlier chats too.";

/**
 * The details open below the link and stay in the viewport. The tooltip is
 * portaled to the page, so it sits above the Settings overlay (z-index 200);
 * at the default z-50 it opened behind the dialog and only its top line
 * showed above the dialog's edge.
 */
export const TRAINING_TOOLTIP_PLACEMENT = {
	side: "bottom",
	align: "start",
	sideOffset: 6,
	collisionPadding: 16,
	className: "z-[210] leading-snug",
} as const;

/**
 * Settings, Privacy: "Help improve ytimesy". Stored off until the user turns it
 * on here or continues past the setup card (training-consent-prompt.tsx).
 */
export function TrainingConsentSettings() {
	const read = useServerFn(readTrainingConsentFn);
	const save = useServerFn(saveTrainingConsentFn);
	const queryClient = useQueryClient();
	const consent = useQuery({ queryKey: CONSENT_KEY, queryFn: () => read() });
	const change = useMutation(trainingConsentChange(queryClient, save));
	return (
		<TrainingConsentView
			enabled={consent.data?.enabled}
			error={saveErrorMessage(change.error) ?? consent.error?.message}
			onChange={(enabled) => change.mutate(enabled)}
		/>
	);
}

export function TrainingConsentView(props: {
	/** Undefined until the saved setting is known: the switch shows as loading. */
	readonly enabled: boolean | undefined;
	readonly error?: string;
	readonly onChange: (enabled: boolean) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Privacy</h3>
					<p>How ytimesy may use your chats.</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label htmlFor="training-consent" className="settings-row-title">
							Help improve ytimesy
						</label>
						<span className="settings-row-meta">
							<TrainingLearnMore />
						</span>
					</div>
					<div className="settings-row-actions">
						<SettingsSwitch
							id="training-consent"
							checked={props.enabled}
							disabled={confirming}
							onCheckedChange={(checked) => {
								if (checked) setConfirming(true);
								else props.onChange(false);
							}}
						/>
					</div>
				</div>
				{confirming ? (
					<div
						role="alertdialog"
						aria-labelledby="training-confirm-title"
						className="settings-row settings-confirm"
					>
						<div className="settings-row-text">
							<span id="training-confirm-title" className="settings-row-title">
								Share your chats to improve ytimesy?
							</span>
							<span
								className="settings-row-meta"
								title="Leave this off for code you are not permitted to share, or exclude those projects in project settings."
							>
								New chats will be eligible.
							</span>
						</div>
						<div className="settings-row-actions">
							<button
								type="button"
								className="settings-secondary"
								onClick={() => setConfirming(false)}
							>
								Cancel
							</button>
							<button
								type="button"
								className="settings-primary"
								onClick={() => {
									setConfirming(false);
									props.onChange(true);
								}}
							>
								Turn on
							</button>
						</div>
					</div>
				) : null}
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</section>
	);
}

/** "Learn more" to the Training Data page; the commitments show as its tooltip. */
export function TrainingLearnMore() {
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<a
						href="/training"
						target="_blank"
						rel="noopener noreferrer"
						className="training-learn-more"
					>
						Learn more<span className="sr-only"> about training data</span>
					</a>
				</TooltipTrigger>
				<TooltipContent {...TRAINING_TOOLTIP_PLACEMENT}>
					{TRAINING_DETAILS}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}

/**
 * "Never use this project for training", shown only while the account setting
 * is on (a project can only exclude itself, never opt in).
 */
export function ProjectTrainingSettings({ projectId }: { projectId: string }) {
	const readConsent = useServerFn(readTrainingConsentFn);
	const read = useServerFn(readProjectTrainingFn);
	const save = useServerFn(saveProjectTrainingFn);
	const queryClient = useQueryClient();
	const key = ["project-training", projectId];
	const consent = useQuery<TrainingConsent>({
		queryKey: CONSENT_KEY,
		queryFn: () => readConsent(),
	});
	const project = useQuery({
		queryKey: key,
		queryFn: () => read({ data: { projectId } }),
		enabled: consent.data?.enabled === true,
	});
	const change = useMutation(
		projectTrainingChange(queryClient, projectId, save),
	);
	if (!consent.data?.enabled) return null;
	return (
		<ProjectTrainingView
			excluded={project.data?.excluded}
			error={saveErrorMessage(change.error)}
			onChange={(excluded) => change.mutate(excluded)}
		/>
	);
}

export function ProjectTrainingView(props: {
	/** Undefined while the project's setting loads. */
	readonly excluded: boolean | undefined;
	readonly error?: string;
	readonly onChange: (excluded: boolean) => void;
}) {
	return (
		<section className="settings-section">
			<header className="settings-section-head">
				<div>
					<h3>Training</h3>
					<p>Your account helps improve ytimesy.</p>
				</div>
			</header>
			<div className="settings-group">
				<div className="settings-row">
					<div className="settings-row-text">
						<label htmlFor="project-training" className="settings-row-title">
							Never use this project for training
						</label>
						<span
							className="settings-row-meta"
							title="Chats in this project are never used to improve ytimesy, even though your account setting is on."
						>
							Overrides your account setting.
						</span>
					</div>
					<div className="settings-row-actions">
						<SettingsSwitch
							id="project-training"
							checked={props.excluded}
							onCheckedChange={props.onChange}
						/>
					</div>
				</div>
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</section>
	);
}
