import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { EnvironmentBuildView } from "#/domain/environment-build-progress";
import type { RepositorySetup } from "#/domain/environment-detection";
import type { EnvironmentModelRequest } from "#/domain/environment-model";
import {
	workspacePrepareShowsStatus,
	workspacePrepareStalled,
} from "#/domain/project-workspace";
import {
	isUnreachableRead,
	requestJson,
	retryTransientRead,
	transientReadRetryDelay,
} from "./api";
import {
	EnvironmentBuildFailureDetail,
	EnvironmentBuildSteps,
	useEnvironmentProgress,
} from "./environment-build-progress";
import { GithubSetupLink } from "./github-setup-link";

/** Projects with a message waiting for their environment (workspace-home.tsx). */
export const HeldForSetupContext = createContext<ReadonlySet<string>>(
	new Set(),
);

const SETUP_STEPS = {
	queued: "Starting",
	provisioning: "Starting the machine",
	cloning: "Cloning the repository",
	installing: "Installing dependencies",
} as const;

export interface WorkspaceView {
	id: string;
	projectId: string;
	status:
		| "queued"
		| "provisioning"
		| "cloning"
		| "installing"
		| "ready"
		| "failed";
	errorMessage: string | null;
	updatedAt: string;
	/** The newest build; a rebuild runs while the workspace stays ready. */
	build?: EnvironmentBuildView | null;
	/** What each repository's active setup is (detected, saved, nothing). */
	setup?: readonly RepositorySetup[] | null;
}

export type WorkspaceRetryMode = "retry" | "rebuild" | "plain";

/** Retry, rebuild or "Send anyway" (clone only) for a project's environment. */
export function retryWorkspace(input: {
	workspaceId: string;
	mode?: WorkspaceRetryMode;
	repairModel?: EnvironmentModelRequest;
}) {
	return requestJson<WorkspaceView>("/api/workspaces/retry", input);
}

/** Whether the status should be read again soon: setup or a rebuild is running. */
export function workspaceStatusIsLive(view: WorkspaceView | null | undefined) {
	if (!view) return false;
	return (
		(view.status !== "ready" && view.status !== "failed") ||
		view.build?.status === "running"
	);
}

/** A project's environment status; read ahead of a project switch too. */
export function workspaceStatusQuery(projectId: string) {
	return queryOptions({
		queryKey: ["workspace", projectId],
		queryFn: () =>
			requestJson<WorkspaceView | null>(
				`/api/workspaces?projectId=${projectId}`,
			),
	});
}

export function WorkspaceStatus({
	projectId,
	repairModel,
	repairModelLabel,
}: {
	projectId: string;
	repairModel?: EnvironmentModelRequest;
	repairModelLabel?: string;
}) {
	const held = useContext(HeldForSetupContext);
	const workspace = useQuery({
		...workspaceStatusQuery(projectId),
		retry: retryTransientRead,
		retryDelay: transientReadRetryDelay,
		refetchInterval: (query) =>
			workspaceStatusIsLive(query.state.data) ? 3000 : false,
	});
	const prepare = useMutation({
		mutationFn: () =>
			requestJson<WorkspaceView>("/api/workspaces", { projectId }),
		onSuccess: () => void workspace.refetch(),
	});
	const retry = useMutation({
		mutationFn: retryWorkspace,
		onSuccess: () => void workspace.refetch(),
	});
	const current = workspace.data;
	const [detailsOpen, setDetailsOpen] = useState(false);
	const building =
		Boolean(current) &&
		current?.status !== "failed" &&
		(current?.status !== "ready" || current.build?.status === "running");
	const progress = useEnvironmentProgress(projectId, {
		enabled: detailsOpen && building,
	});
	const queuedMissing = useRef<string | null>(null);
	useEffect(() => {
		if (
			queuedMissing.current === projectId ||
			workspace.isPending ||
			workspace.error ||
			current
		)
			return;
		queuedMissing.current = projectId;
		prepare.mutate();
	}, [current, prepare, projectId, workspace.error, workspace.isPending]);
	if (workspace.isPending) return null;
	if (workspace.error && isUnreachableRead(workspace.error))
		return (
			<p className="workspace-status">
				<span>Couldn't refresh the workspace.</span>
				<button
					type="button"
					disabled={workspace.isFetching}
					onClick={() => void workspace.refetch()}
				>
					{workspace.isFetching ? "Retrying…" : "Retry"}
				</button>
			</p>
		);
	if (workspace.error)
		return (
			<p className="workspace-status" role="alert">
				{workspace.error.message}{" "}
				<GithubSetupLink message={workspace.error.message} />
			</p>
		);
	if (!current) return null;
	// A held message shows the setup in the chat itself.
	if (held.has(projectId)) return null;
	// Polling while queued re-renders this, so the stall check advances with time.
	const stalled = workspacePrepareStalled(current, Date.now());
	const rebuilding =
		current.status === "ready" && current.build?.status === "running";
	if (!stalled && (rebuilding || current.status !== "ready") && building)
		return (
			<div className="workspace-status-live">
				<button
					type="button"
					className="workspace-status workspace-status-progress"
					aria-expanded={detailsOpen}
					onClick={() => setDetailsOpen((open) => !open)}
				>
					<LoaderCircle size={13} className="workspace-status-spin" />
					<span>
						{rebuilding
							? "Rebuilding environment…"
							: `Setting up the project · ${SETUP_STEPS[current.status as keyof typeof SETUP_STEPS] ?? "Starting"}`}
					</span>
				</button>
				{detailsOpen ? (
					<div className="workspace-status-details">
						<EnvironmentBuildSteps steps={progress.data?.steps ?? []} />
					</div>
				) : null}
			</div>
		);
	if (!stalled && !workspacePrepareShowsStatus(current.status)) return null;
	const failure = current.build?.status === "failed" ? current.build : null;
	return (
		<div className="workspace-status" role="alert">
			<div className="workspace-status-message">
				{stalled ? (
					"Environment setup has not started yet."
				) : failure?.failure ? (
					<EnvironmentBuildFailureDetail
						failure={failure.failure}
						message={failure.errorMessage}
					/>
				) : (
					(current.errorMessage ?? "Workspace preparation failed.")
				)}
				{current.errorMessage ? (
					<>
						{" "}
						<GithubSetupLink message={current.errorMessage} />
					</>
				) : null}
			</div>
			<button
				type="button"
				disabled={retry.isPending}
				onClick={() => retry.mutate({ workspaceId: current.id })}
			>
				{retry.isPending ? "Retrying…" : "Retry"}
			</button>
			{stalled ? null : (
				<button
					type="button"
					disabled={retry.isPending}
					title="Chats start with the repository cloned; the agent installs what it needs"
					onClick={() =>
						retry.mutate({ workspaceId: current.id, mode: "plain" })
					}
				>
					Skip setup
				</button>
			)}
			{repairModel && (
				<button
					type="button"
					disabled={retry.isPending}
					onClick={() =>
						retry.mutate({
							workspaceId: current.id,
							repairModel: {
								...repairModel,
								allowApi: repairModel.harness === "api",
							},
						})
					}
				>
					Repair with {repairModelLabel || "selected model"}
					{repairModel.harness === "api"
						? " (API charges apply)"
						: " (subscription usage)"}
				</button>
			)}
			{retry.error && <span>{retry.error.message}</span>}
		</div>
	);
}
