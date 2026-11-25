import { queryOptions, useQuery } from "@tanstack/react-query";
import {
	Check,
	ChevronRight,
	Clock3,
	LoaderCircle,
	Minus,
	Wrench,
	X,
} from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
	type EnvironmentBuildFailure,
	type EnvironmentBuildProgress,
	type EnvironmentBuildStepView,
	environmentFailureSummary,
	stepDuration,
} from "#/domain/environment-build-progress";
import {
	isSetupRequestMessage,
	PROJECT_SETUP_NAME,
} from "#/domain/environment-setup";
import { setupCard } from "#/domain/setup-card";
import { hubTopic } from "#/domain/user-hub";
import { useAutoGrow } from "../app/use-auto-grow";
import {
	pollUnlessPushed,
	useHubDelivery,
	useHubRead,
} from "../workspace/user-hub-store";
import { requestJson } from "./api";
import { GithubSetupStep } from "./github-setup-step";
import { SetupCard } from "./setup-card";

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
 * The newest build's steps. Read only when shown. While the user's hub
 * pushes, read again when the project's environment changes (a step starts,
 * ends or prints); otherwise polled while a build runs (or `waiting` says
 * one is about to start).
 */
export function useEnvironmentProgress(
	projectId: string,
	options: { enabled: boolean; waiting?: boolean },
) {
	const delivery = useHubDelivery();
	const enabled = options.enabled && Boolean(projectId);
	const progress = useQuery({
		...environmentProgressQuery(projectId),
		enabled,
		refetchInterval: (query) =>
			query.state.data?.build?.status === "running" || options.waiting
				? pollUnlessPushed(delivery, BUILD_PROGRESS_POLL_MS)
				: false,
	});
	useHubRead(
		[hubTopic.workspace(projectId)],
		() => void progress.refetch({ cancelRefetch: false }),
		{ enabled },
	);
	return progress;
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
	const editField = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(editField, draft ?? "");
	const editing = draft !== null;
	const edited = (draft ?? "").trim();
	const progress = useEnvironmentProgress(projectId, {
		enabled: true,
		waiting: !failed,
	});
	const showFailure = failed && progress.data?.build?.status !== "running";
	// The setup's own request is the system's, not the person's message.
	if (isSetupRequestMessage(text))
		return (
			<>
				{showMessage ? <SetupRequestRow /> : null}
				<ProjectSetupBuild
					projectId={projectId}
					waiting
					failed={failed}
					actions={actions}
				/>
			</>
		);
	return (
		<>
			<div className="session-message" data-role="user" data-queued="true">
				{showMessage ? (
					editing ? (
						<textarea
							ref={editField}
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
			<ProjectSetupBuild
				projectId={projectId}
				waiting
				failed={failed}
				actions={actions}
			/>
		</>
	);
}

/** The open chat's project, for the setup's request shown in its transcript. */
export const SetupProjectContext = createContext<string | null>(null);

/** The setup's request in its chat: one line where a message would be. */
export function SetupRequestRow() {
	return (
		<p className="setup-request-row">
			<Wrench size={13} aria-hidden="true" />
			<span>{PROJECT_SETUP_NAME}</span>
		</p>
	);
}

/**
 * The setup's request once sent (the agent took it): its line, then the
 * environment build it ran after, done and folded (or a rebuild running).
 */
export function SetupRequestItem() {
	const projectId = useContext(SetupProjectContext);
	return (
		<>
			<SetupRequestRow />
			{projectId ? <ProjectSetupBuild projectId={projectId} /> : null}
		</>
	);
}

/** "43s", "2m 05s": how long the build took, or has taken so far. */
function buildDuration(build: EnvironmentBuildProgress["build"], now: number) {
	return build
		? stepDuration(
				{ startedAt: build.startedAt, completedAt: build.completedAt },
				now,
			)
		: null;
}

/**
 * The project's environment build in its setup chat: every step with its
 * time and the running command's last lines while it runs; folded to one
 * line once ready; the failure with what to do next.
 */
export function ProjectSetupBuild({
	projectId,
	waiting = false,
	failed = false,
	actions,
}: {
	projectId: string;
	/** A request waits for this build: read until it runs, even before it shows. */
	waiting?: boolean;
	/** The project's setup failed (its status), even before the build row shows it. */
	failed?: boolean;
	/** For the request still waiting: Retry, Send anyway, the agent. */
	actions?: HeldSetupActions;
}) {
	const progress = useEnvironmentProgress(projectId, {
		enabled: true,
		waiting: waiting && !failed,
	});
	const build = progress.data?.build ?? null;
	const running = build?.status === "running";
	const showFailure =
		(failed && !running) || (!waiting && build?.status === "failed");
	const now = useNow(running);
	// Until a retried build starts, the last one's steps are not this setup's.
	const steps =
		running || showFailure || build?.status === "ready"
			? (progress.data?.steps ?? [])
			: [];
	if (!waiting && !build) return null;
	// Ready: one line (the agent, when the request waits, starts in a moment).
	if (build?.status === "ready" && !showFailure)
		return (
			<details className="environment-build" data-state="ready">
				<summary className="environment-build-title">
					<Check size={14} aria-hidden="true" />
					<span>
						{build.rebuild ? "Environment updated" : "Environment ready"}
					</span>
					<span className="session-activity-status">
						{buildDuration(build, now)}
					</span>
					<ChevronRight
						size={14}
						strokeWidth={1.5}
						className="session-activity-chevron"
						aria-hidden="true"
					/>
				</summary>
				<EnvironmentBuildSteps steps={steps} />
			</details>
		);
	const model = setupCard({
		status: showFailure ? "failed" : build ? "provisioning" : "queued",
		build,
		retrying: Boolean(actions?.pending) && showFailure,
	});
	const runningStep = steps.find((step) => step.state === "running");
	const shown = {
		...model,
		title:
			model.state === "building" && !build?.rebuild
				? "Setting up project"
				: model.title,
		reason: runningStep?.label ?? model.reason,
	};
	const failure = build?.failure ?? null;
	return (
		<SetupCard
			model={shown}
			meta={running ? buildDuration(build, now) : null}
			{...(actions && showFailure && model.state !== "retrying"
				? {
						primary: {
							label: model.state === "needs-github" ? "Check again" : "Retry",
							onClick: actions.onRetry,
							disabled: actions.pending,
						},
						secondary: [
							{
								label: "Send anyway",
								onClick: actions.onSendAnyway,
								disabled: actions.pending,
								title:
									"Send on a machine with the repository cloned; the agent installs what it needs",
							},
							...(actions.onSetUpWithAgent
								? [
										{
											label: "Fix with the agent",
											onClick: actions.onSetUpWithAgent,
											disabled: actions.pending,
											title: "The agent fixes the setup first, then saves it",
										},
									]
								: []),
						],
					}
				: {})}
			details={
				<>
					<EnvironmentBuildSteps steps={steps} />
					{failure?.output ? (
						<pre className="environment-build-output">{failure.output}</pre>
					) : null}
				</>
			}
		>
			{model.state === "needs-github" ? (
				<GithubSetupStep message={model.reason} />
			) : null}
		</SetupCard>
	);
}
