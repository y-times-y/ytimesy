import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { workspacePrepareShowsStatus } from "#/domain/project-workspace";
import { requestJson } from "./api";
import { GithubSetupLink } from "./github-setup-link";

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

export function WorkspaceStatus({ projectId }: { projectId: string }) {
	const workspace = useQuery({
		queryKey: ["workspace", projectId],
		queryFn: () =>
			requestJson<WorkspaceView | null>(
				`/api/workspaces?projectId=${projectId}`,
			),
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
		mutationFn: (workspaceId: string) =>
			requestJson<WorkspaceView>("/api/workspaces/retry", { workspaceId }),
		onSuccess: () => void workspace.refetch(),
	});
	const current = workspace.data;
	const queuedMissing = useRef(false);
	useEffect(() => {
		queuedMissing.current = false;
	}, [projectId]);
	useEffect(() => {
		if (
			queuedMissing.current ||
			workspace.isPending ||
			workspace.error ||
			current
		)
			return;
		queuedMissing.current = true;
		prepare.mutate();
	}, [current, prepare, workspace.error, workspace.isPending]);
	if (workspace.isPending) return null;
	if (workspace.error)
		return (
			<p className="workspace-status" role="alert">
				{workspace.error.message}{" "}
				<GithubSetupLink message={workspace.error.message} />
			</p>
		);
	if (!current || !workspacePrepareShowsStatus(current.status)) return null;
	return (
		<p className="workspace-status" role="alert">
			<span>
				{current.errorMessage ?? "Workspace preparation failed."}
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
				onClick={() => retry.mutate(current.id)}
			>
				{retry.isPending ? "Retrying…" : "Retry"}
			</button>
		</p>
	);
}
