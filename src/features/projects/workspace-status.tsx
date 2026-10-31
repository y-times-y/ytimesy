import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";
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
		refetchInterval: (query) => {
			const status = query.state.data?.status;
			return status &&
				status !== "ready" &&
				status !== "failed" &&
				status !== undefined
				? 3000
				: false;
		},
	});
	const prepare = useMutation({
		mutationFn: () =>
			requestJson<WorkspaceView>("/api/workspaces", { projectId }),
		onSuccess: () => void workspace.refetch(),
	});
	const retry = useMutation({
		mutationFn: (input: {
			workspaceId: string;
			repairModel?: EnvironmentModelRequest;
		}) => requestJson<WorkspaceView>("/api/workspaces/retry", input),
		onSuccess: () => void workspace.refetch(),
	});
	const current = workspace.data;
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
	// Polling while queued re-renders this, so the stall check advances with time.
	const stalled = workspacePrepareStalled(current, Date.now());
	if (!stalled && current.status !== "ready" && current.status !== "failed")
		return (
			<p className="workspace-status workspace-status-progress" role="status">
				<LoaderCircle size={13} className="workspace-status-spin" />
				<span>
					Setting up the project · {SETUP_STEPS[current.status]}
					{held.has(projectId) ? ". Your message sends when it's ready." : ""}
				</span>
			</p>
		);
	if (!stalled && !workspacePrepareShowsStatus(current.status)) return null;
	return (
		<p className="workspace-status" role="alert">
			<span>
				{stalled
					? "Environment setup has not started yet."
					: (current.errorMessage ?? "Workspace preparation failed.")}
				{current.errorMessage ? (
					<>
						{" "}
						<GithubSetupLink message={current.errorMessage} />
					</>
				) : null}
			</span>
			<button
				type="button"
				disabled={retry.isPending}
				onClick={() => retry.mutate({ workspaceId: current.id })}
			>
				{retry.isPending ? "Retrying…" : "Retry"}
			</button>
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
		</p>
	);
}
