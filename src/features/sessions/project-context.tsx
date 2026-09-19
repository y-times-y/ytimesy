import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { branchSwitchBlockedReason } from "../../domain/project-workspace";
import { projectFolderName, type Project } from "../../domain/projects";
import {
	listedSessionBranches,
	sessionWorkingBranch,
} from "../../domain/session-branch";
import { requestJson } from "../projects/api";
import { GithubSetupLink } from "../projects/github-setup-link";
import {
	WorkspaceStatus,
	type WorkspaceView,
} from "../projects/workspace-status";
import { ProjectPicker } from "./project-picker";

export function ProjectContext({
	projects,
	selectedProject,
	onSelectProject,
	projectLocked = false,
	projectPickerOpen,
	onProjectPickerOpenChange,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	projectLocked?: boolean;
	projectPickerOpen?: boolean;
	onProjectPickerOpenChange?: (open: boolean) => void;
}) {
	return (
		<div className="session-context">
			{projectLocked ? null : (
				<ProjectPicker
					projects={projects}
					selectedProject={selectedProject}
					onSelectProject={onSelectProject}
					open={projectPickerOpen}
					onOpenChange={onProjectPickerOpenChange}
				/>
			)}
			<BranchSelect project={selectedProject} />
			{selectedProject && <WorkspaceStatus projectId={selectedProject.id} />}
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
			requestJson<{ branches: string[]; defaultBranch: string }>(
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
	const remote = branches.data?.branches ?? [];
	const workingBranch = project
		? sessionWorkingBranch({
				selectedBranch: project.branch,
				defaultBranch: branches.data?.defaultBranch,
				title: projectFolderName(project.fullName),
				id: String(project.repositoryId),
			})
		: "";
	const names = listedSessionBranches({
		remoteBranches: [...(project ? [project.branch] : []), ...remote],
		workingBranch,
	});
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
				value={workingBranch}
				disabled={disabled}
				onValueChange={(branch) => {
					if (!project || branch === workingBranch) return;
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
