import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { EnvironmentModelRequest } from "#/domain/environment-model";
import type { Project } from "../../domain/projects";
import { listedSessionBranches } from "../../domain/session-branch";
import { requestJson } from "../projects/api";
import { GithubSetupLink } from "../projects/github-setup-link";
import { WorkspaceStatus } from "../projects/workspace-status";
import { selectProjectChatBranch } from "./agent-session.fn";
import { ProjectPicker } from "./project-picker";

export function ProjectContext({
	projects,
	selectedProject,
	onSelectProject,
	projectLocked = false,
	projectPickerOpen,
	onProjectPickerOpenChange,
	repairModel,
	repairModelLabel,
	sessionId,
	selectedBranch,
	onBranchChange,
	branchLocked = false,
	hasConversation = false,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	projectLocked?: boolean;
	projectPickerOpen?: boolean;
	onProjectPickerOpenChange?: (open: boolean) => void;
	repairModel?: EnvironmentModelRequest;
	repairModelLabel?: string;
	sessionId?: string | null;
	selectedBranch?: string | null;
	onBranchChange?: (branch: string) => void;
	branchLocked?: boolean;
	hasConversation?: boolean;
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
			<BranchSelect
				key={sessionId ?? selectedProject?.id}
				project={selectedProject}
				sessionId={sessionId}
				selectedBranch={selectedBranch}
				onBranchChange={onBranchChange}
				locked={branchLocked}
				hasConversation={hasConversation}
			/>
			{selectedProject && (
				<WorkspaceStatus
					projectId={selectedProject.id}
					repairModel={repairModel}
					repairModelLabel={repairModelLabel}
				/>
			)}
		</div>
	);
}

function BranchSelect({
	project,
	sessionId,
	selectedBranch,
	onBranchChange,
	locked,
	hasConversation,
}: {
	project?: Project;
	sessionId?: string | null;
	selectedBranch?: string | null;
	onBranchChange?: (branch: string) => void;
	locked?: boolean;
	hasConversation?: boolean;
}) {
	const selectBranch = useServerFn(selectProjectChatBranch);
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
		mutationFn: async (branch: string) => {
			if (!sessionId) return;
			return selectBranch({
				data: {
					projectId: project?.id ?? "",
					sessionId: sessionId ?? "",
					branch,
				},
			});
		},
		onSuccess: (_result, branch) => {
			onBranchChange?.(branch);
		},
	});
	const remote = branches.data?.branches ?? [];
	const workingBranch =
		selectedBranch ??
		(hasConversation ? project?.branch : branches.data?.defaultBranch) ??
		project?.branch ??
		"";
	const names = listedSessionBranches({
		remoteBranches: [...(project ? [project.branch] : []), ...remote],
		workingBranch,
	});
	const disabled =
		!project ||
		locked ||
		switchBranch.isPending ||
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
