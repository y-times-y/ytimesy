import { queryOptions, useQuery } from "@tanstack/react-query";
import { Check, Clock3, LoaderCircle, Minus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import {
	type EnvironmentBuildFailure,
	type EnvironmentBuildProgress,
	type EnvironmentBuildStepView,
	environmentFailureSummary,
	stepDuration,
} from "#/domain/environment-build-progress";
import { requestJson } from "./api";

/** How often the live view reads a running build (ms). */
export const BUILD_PROGRESS_POLL_MS = 1_500;

export function environmentProgressQuery(projectId: string) {
	return queryOptions({
		queryKey: ["workspace-progress", projectId],
		queryFn: () =>
			requestJson<EnvironmentBuildProgress>(
				`/api/workspaces?projectId=${projectId}&progress=1`,
			),
	});
}

/**
 * The newest build's steps. Read only when shown, and polled only while a
 * build runs (or `waiting` says one is about to start).
 */
export function useEnvironmentProgress(
	projectId: string,
	options: { enabled: boolean; waiting?: boolean },
) {
	return useQuery({
		...environmentProgressQuery(projectId),
		enabled: options.enabled && Boolean(projectId),
		refetchInterval: (query) =>
			query.state.data?.build?.status === "running" || options.waiting
				? BUILD_PROGRESS_POLL_MS
				: false,
	});
}

/** Re-renders every second while `live`, for running durations. */
function useNow(live: boolean) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!live) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [live]);
	return now;
}

const STEP_ICON = {
	running: <LoaderCircle size={13} className="workspace-status-spin" />,
	done: <Check size={13} />,
	failed: <X size={13} />,
	skipped: <Minus size={13} />,
} as const;

/** The build's steps as activity rows, with the running command's last lines. */
export function EnvironmentBuildSteps({
	steps,
}: {
	steps: readonly EnvironmentBuildStepView[];
}) {
	const live = steps.some((step) => step.state === "running");
	const now = useNow(live);
	if (!steps.length) return null;
	return (
		<ol className="environment-build-steps">
			{steps.map((step) => (
				<li key={step.key} data-state={step.state}>
					<p className="environment-build-step">
						<span className="environment-build-icon" aria-hidden="true">
							{STEP_ICON[step.state]}
						</span>
						<span className="environment-build-label">{step.label}</span>
						{step.command ? (
							<code className="environment-build-command">{step.command}</code>
						) : null}
						<span className="session-activity-status">
							{step.state === "skipped"
								? (step.note ?? "Skipped")
								: [
										step.state === "failed" && step.exitCode !== null
											? `exit ${step.exitCode}`
											: step.note,
										stepDuration(step, now),
									]
										.filter(Boolean)
										.join(" · ")}
						</span>
					</p>
					{step.output &&
					(step.state === "running" || step.state === "failed") ? (
						<pre className="environment-build-output">{step.output}</pre>
					) : null}
				</li>
			))}
		</ol>
	);
}

/** A failed build's reason: the command, its exit code and its last lines. */
export function EnvironmentBuildFailureDetail({
	failure,
	message,
}: {
	failure: EnvironmentBuildFailure | null;
	message: string | null;
}) {
	return (
		<div className="environment-build-failure">
			<p>
				{failure
					? environmentFailureSummary(failure)
					: (message ?? "Setup did not finish.")}
			</p>
			{failure?.output ? (
				<pre className="environment-build-output">{failure.output}</pre>
			) : null}
		</div>
	);
}

export type HeldSetupActions = {
	readonly onRetry: () => void;
	/** Clones only and sends; the agent installs what it needs. */
	readonly onSendAnyway: () => void;
	/** Only for a new chat's first message. */
	readonly onSetUpWithAgent?: () => void;
	readonly pending: boolean;
};

/**
 * A message sent while the project's machine is being prepared: it shows as
 * sent, waiting, with the setup streaming below it. It goes out by itself
 * when the machine is ready; a failure keeps it here with what to do next.
 */
export function HeldForSetupMessage({
	projectId,
	text,
	showMessage,
	failed,
	actions,
	onEdit,
	onRemove,
}: {
	projectId: string;
	text: string;
	/** False when the transcript already shows the message (the composer's copy). */
	showMessage: boolean;
	/** The project's setup failed (its status), even before the build row shows it. */
	failed: boolean;
	actions: HeldSetupActions;
	/** The message is stored in the chat: it can be rewritten before it goes. */
	onEdit?: (text: string) => void;
	/** ...or taken back. */
	onRemove?: () => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const editing = draft !== null;
	const edited = (draft ?? "").trim();
	const progress = useEnvironmentProgress(projectId, {
		enabled: true,
		waiting: !failed,
	});
	const build = progress.data?.build ?? null;
	const showFailure = failed && build?.status !== "running";
	// Until a retried build starts, the last one's steps are not this setup's.
	const steps =
		build?.status === "running" || showFailure
			? (progress.data?.steps ?? [])
			: [];
	return (
		<>
			<div className="session-message" data-role="user" data-queued="true">
				{showMessage ? (
					editing ? (
						<textarea
							className="session-queued-edit"
							aria-label="Edit held message"
							rows={Math.min(8, Math.max(2, draft.split("\n").length))}
							value={draft}
							onChange={(event) => setDraft(event.currentTarget.value)}
						/>
					) : (
						<p>{text}</p>
					)
				) : null}
				<p className="session-queued-note" role="status">
					<Clock3 size={14} strokeWidth={1.5} aria-hidden="true" />
					<span>
						{showFailure ? "Not sent: setup failed" : "Waiting for setup"}
					</span>
					{showMessage && onEdit ? (
						editing ? (
							<>
								<button
									type="button"
									className="session-queued-action"
									disabled={!edited}
									onClick={() => {
										if (!edited) return;
										onEdit(edited);
										setDraft(null);
									}}
								>
									Save
								</button>
								<button
									type="button"
									className="session-queued-action"
									onClick={() => setDraft(null)}
								>
									Cancel
								</button>
							</>
						) : (
							<button
								type="button"
								className="session-queued-action"
								aria-label="Edit held message"
								onClick={() => setDraft(text)}
							>
								Edit
							</button>
						)
					) : null}
					{showMessage && onRemove ? (
						<button
							type="button"
							aria-label="Remove held message"
							title="Remove this message before it is sent"
							onClick={onRemove}
						>
							<X size={14} strokeWidth={1.5} aria-hidden="true" />
						</button>
					) : null}
				</p>
			</div>
			<section
				className="environment-build"
				aria-label="Project setup"
				data-state={showFailure ? "failed" : "running"}
			>
				<p className="environment-build-title">
					{showFailure ? (
						<X size={14} aria-hidden="true" />
					) : (
						<MatrixDotLoader />
					)}
					<span>
						{showFailure ? "Setup failed" : "Setting up your project"}
					</span>
				</p>
				<EnvironmentBuildSteps steps={steps} />
				{showFailure ? (
					<>
						<EnvironmentBuildFailureDetail
							failure={build?.failure ?? null}
							message={build?.errorMessage ?? null}
						/>
						<div className="environment-build-actions">
							<button
								type="button"
								disabled={actions.pending}
								onClick={actions.onRetry}
							>
								Retry
							</button>
							<button
								type="button"
								disabled={actions.pending}
								onClick={actions.onSendAnyway}
								title="Send on a machine with the repository cloned; the agent installs what it needs"
							>
								Send anyway
							</button>
							{actions.onSetUpWithAgent ? (
								<button
									type="button"
									disabled={actions.pending}
									onClick={actions.onSetUpWithAgent}
									title="The agent fixes the setup first, then saves it"
								>
									Set up with the agent
								</button>
							) : null}
						</div>
					</>
				) : null}
			</section>
		</>
	);
}
