import { useMutation, useQuery } from "@tanstack/react-query";
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

const copy: Record<WorkspaceView["status"], string> = {
	queued: "Workspace queued. The worker picks it up next.",
	provisioning: "Provisioning workspace…",
	cloning: "Cloning repository…",
	installing: "Installing dependencies…",
	ready: "Workspace ready.",
	failed: "Workspace preparation failed.",
};

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
	if (workspace.isPending)
		return <p className="workspace-status">Checking workspace…</p>;
	if (workspace.error)
		return (
			<p className="workspace-status" role="alert">
				{workspace.error.message}{" "}
				<GithubSetupLink message={workspace.error.message} />
			</p>
		);
	if (!current)
		return (
			<p className="workspace-status">
				<button
					type="button"
					disabled={prepare.isPending}
					onClick={() => prepare.mutate()}
				>
					{prepare.isPending ? "Queuing…" : "Prepare workspace"}
				</button>
			</p>
		);
	return (
		<p
			className="workspace-status"
			role={current.status === "failed" ? "alert" : "status"}
		>
			<span>
				{current.status === "failed"
					? (current.errorMessage ?? copy.failed)
					: copy[current.status]}
				{current.status === "failed" && current.errorMessage && (
					<>
						{" "}
						<GithubSetupLink message={current.errorMessage} />
					</>
				)}
			</span>
			{current.status === "failed" && (
				<button
					type="button"
					disabled={retry.isPending}
					onClick={() => retry.mutate(current.id)}
				>
					{retry.isPending ? "Retrying…" : "Retry"}
				</button>
			)}
		</p>
	);
}
