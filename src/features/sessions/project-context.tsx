import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { branchSwitchBlockedReason } from "../../domain/project-workspace";
import type { Project } from "../../domain/projects";
import { requestJson } from "../projects/api";
import { GithubSetupLink } from "../projects/github-setup-link";
import {
	WorkspaceStatus,
	type WorkspaceView,
} from "../projects/workspace-status";

export function ProjectContext({
	projects,
	selectedProject,
	onSelectProject,
	sessionId,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	sessionId?: string | null;
}) {
	return (
		<div className="session-context">
			<Select value={selectedProject?.id ?? ""} onValueChange={onSelectProject}>
				<SelectTrigger
					className="context-select project-select"
					aria-label="Project"
				>
					<GitBranch size={14} />
					<SelectValue placeholder="Select project" />
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="top"
					align="start"
					sideOffset={8}
				>
					{projects.length ? (
						projects.map((project) => (
							<SelectItem key={project.id} value={project.id}>
								{project.fullName}
							</SelectItem>
						))
					) : (
						<SelectItem value="empty" disabled>
							No projects added yet
						</SelectItem>
					)}
				</SelectContent>
			</Select>
			<BranchSelect project={selectedProject} />
			{selectedProject && <WorkspaceStatus projectId={selectedProject.id} />}
			{selectedProject && (
				<PublicationAction
					key={selectedProject.id}
					projectId={selectedProject.id}
					sessionId={sessionId}
				/>
			)}
		</div>
	);
}

function BranchSelect({ project }: { project?: Project }) {
	const queryClient = useQueryClient();
	const workspace = useQuery({
		queryKey: ["workspace", project?.id],
		queryFn: () =>
			requestJson<WorkspaceView | null>(
				`/api/workspaces?projectId=${project?.id}`,
			),
		enabled: !!project,
	});
	const branches = useQuery({
		queryKey: [
			"github",
			"branches",
			project?.installationId,
			project?.repositoryId,
		],
		queryFn: () =>
			requestJson<string[]>(
				`/api/github/branches?installationId=${project?.installationId}&repositoryId=${project?.repositoryId}`,
			),
		enabled: !!project,
		retry: false,
	});
	const switchBranch = useMutation({
		mutationFn: (branch: string) =>
			requestJson<Project>("/api/projects", {
				installationId: project?.installationId,
				repositoryId: project?.repositoryId,
				branch,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["projects"] });
			void queryClient.invalidateQueries({
				queryKey: ["workspace", project?.id],
			});
		},
	});
	const names = [
		...new Set([
			...(project ? [project.branch] : []),
			...(branches.data ?? []),
		]),
	];
	const preparing = branchSwitchBlockedReason(workspace.data?.status);
	const disabled =
		!project ||
		switchBranch.isPending ||
		workspace.isPending ||
		Boolean(preparing) ||
		branches.isPending ||
		branches.isError;
	const error = switchBranch.error ?? (project ? branches.error : null);
	return (
		<>
			<Select
				value={project?.branch ?? ""}
				disabled={disabled}
				onValueChange={(branch) => {
					if (!project || branch === project.branch) return;
					switchBranch.mutate(branch);
				}}
			>
				<SelectTrigger
					className="context-select branch-select"
					aria-label="Branch"
				>
					<SelectValue placeholder="Branch" />
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="top"
					align="start"
					sideOffset={8}
				>
					{names.length ? (
						names.map((name) => (
							<SelectItem key={name} value={name}>
								{name}
							</SelectItem>
						))
					) : (
						<SelectItem value="empty" disabled>
							Branch
						</SelectItem>
					)}
				</SelectContent>
			</Select>
			{error && (
				<p className="context-alert" role="alert">
					{error.message} <GithubSetupLink message={error.message} />
				</p>
			)}
		</>
	);
}

function PublicationAction({
	projectId,
	sessionId,
}: {
	projectId: string;
	sessionId?: string | null;
}) {
	const [title, setTitle] = useState("");
	const publish = useMutation({
		mutationFn: () =>
			requestJson<{ url: string; number: number; draft: boolean }>(
				"/api/projects/publish",
				{ projectId, sessionId, title },
			),
	});
	const message = publish.error?.message;
	return (
		<form
			className="publication-action"
			onSubmit={(event) => {
				event.preventDefault();
				publish.mutate();
			}}
		>
			<input
				id="pull-request-title"
				aria-label="Pull request title"
				placeholder="Pull request title"
				value={title}
				maxLength={256}
				required
				onChange={(event) => {
					setTitle(event.target.value);
					publish.reset();
				}}
			/>
			<button type="submit" disabled={publish.isPending || !title.trim()}>
				{publish.isPending ? "Creating…" : "Create pull request"}
			</button>
			{publish.data && (
				<a href={publish.data.url} target="_blank" rel="noreferrer">
					Draft PR #{publish.data.number}
				</a>
			)}
			{message && (
				<p role="alert">
					{message} <GithubSetupLink message={message} />
				</p>
			)}
		</form>
	);
}
