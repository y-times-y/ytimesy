import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Switch } from "#/components/ui/switch";
import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import type { TrainingConsent } from "#/domain/training-consent";
import {
	chooseReplay,
	useReplayConsent,
} from "../analytics/replay-consent-banner";
import {
	readProjectTrainingFn,
	readTrainingConsentFn,
	saveProjectTrainingFn,
	saveTrainingConsentFn,
} from "./training-consent.fn";

const CONSENT_KEY = ["training-consent"];

/** Settings, Privacy: "Help improve ytimesy", off unless the user turns it on. */
export function TrainingConsentSettings() {
	const read = useServerFn(readTrainingConsentFn);
	const save = useServerFn(saveTrainingConsentFn);
	const queryClient = useQueryClient();
	const consent = useQuery({ queryKey: CONSENT_KEY, queryFn: () => read() });
	const change = useMutation({
		mutationFn: (enabled: boolean) =>
			save({ data: { enabled, policyVersion: TRAINING_POLICY_VERSION } }),
		onSuccess: (next) => queryClient.setQueryData(CONSENT_KEY, next),
	});
	return (
		<TrainingConsentView
			enabled={consent.data?.enabled ?? false}
			loading={consent.isPending}
			saving={change.isPending}
			error={change.error?.message ?? consent.error?.message}
			onChange={(enabled) => change.mutate(enabled)}
		/>
	);
}

export function TrainingConsentView(props: {
	readonly enabled: boolean;
	readonly loading?: boolean;
	readonly saving?: boolean;
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
							Let ytimesy use your chats from now on, including prompts, agent
							actions and the code the agent reads or writes, to improve our
							agents and train our own models. We remove account details and
							secrets first, and never share it with model providers. Your API
							keys, secrets and attachments are never included. Turn this off
							any time; we stop immediately and delete what we kept within 30
							days.{" "}
							<a
								href="/training"
								target="_blank"
								rel="noopener noreferrer"
								className="underline underline-offset-4"
							>
								Learn more<span className="sr-only"> about training data</span>
							</a>
						</span>
					</div>
					<div className="settings-row-actions">
						<Switch
							id="training-consent"
							checked={props.enabled}
							disabled={props.loading || props.saving || confirming}
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
							<span className="settings-row-meta">
								New chats will be eligible. Leave this off for code you are not
								permitted to share, or exclude those projects in project
								settings.
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
				<ReplayConsentRow />
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</section>
	);
}

/** Withdrawing replay consent is as easy as giving it (this browser only). */
function ReplayConsentRow() {
	const choice = useReplayConsent();
	return (
		<div className="settings-row">
			<div className="settings-row-text">
				<label htmlFor="replay-consent" className="settings-row-title">
					Session recording
				</label>
				<span className="settings-row-meta">
					Record how you use ytimesy in this browser, with all text, code, chats
					and inputs hidden, to help us improve it.
				</span>
			</div>
			<div className="settings-row-actions">
				<Switch
					id="replay-consent"
					checked={choice === "accepted"}
					disabled={choice === undefined}
					onCheckedChange={(checked) =>
						chooseReplay(checked ? "accepted" : "declined")
					}
				/>
			</div>
		</div>
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
	const change = useMutation({
		mutationFn: (excluded: boolean) => save({ data: { projectId, excluded } }),
		onSuccess: (next) => queryClient.setQueryData(key, next),
	});
	if (!consent.data?.enabled || !project.data) return null;
	return (
		<ProjectTrainingView
			excluded={project.data.excluded}
			saving={change.isPending}
			error={change.error?.message}
			onChange={(excluded) => change.mutate(excluded)}
		/>
	);
}

export function ProjectTrainingView(props: {
	readonly excluded: boolean;
	readonly saving?: boolean;
	readonly error?: string;
	readonly onChange: (excluded: boolean) => void;
}) {
	return (
		<div className="settings-group">
			<div className="settings-row">
				<div className="settings-row-text">
					<label htmlFor="project-training" className="settings-row-title">
						Never use this project for training
					</label>
					<span className="settings-row-meta">
						Chats in this project are never used to improve ytimesy, even though
						your account setting is on.
					</span>
				</div>
				<div className="settings-row-actions">
					<Switch
						id="project-training"
						checked={props.excluded}
						disabled={props.saving}
						onCheckedChange={props.onChange}
					/>
				</div>
			</div>
			{props.error ? <p role="alert">{props.error}</p> : null}
		</div>
	);
}
