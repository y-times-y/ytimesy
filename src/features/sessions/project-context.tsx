import type { EnvironmentModelRequest } from "#/domain/environment-model";
import type { Project } from "../../domain/projects";
import { WorkspaceStatus } from "../projects/workspace-status";
import { BaseBranchPicker } from "./base-branch-picker";
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
	baseBranch = null,
	onBaseBranchChange,
	currentBranch,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	projectLocked?: boolean;
	projectPickerOpen?: boolean;
	onProjectPickerOpenChange?: (open: boolean) => void;
	repairModel?: EnvironmentModelRequest;
	repairModelLabel?: string;
	/** The branch picked for a new chat; null keeps the default. */
	baseBranch?: string | null;
	onBaseBranchChange?: (branch: string) => void;
	/** The open chat's branch, shown read-only once it has started. */
	currentBranch?: string | null;
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
			<BaseBranchPicker
				project={selectedProject}
				value={baseBranch}
				onChange={(branch) => onBaseBranchChange?.(branch)}
				currentBranch={currentBranch}
				locked={projectLocked || !onBaseBranchChange}
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
