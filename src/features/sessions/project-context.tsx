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
	branchless = false,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
	projectLocked?: boolean;
	/** Reruns project setup; shown on a new chat until a setup is saved. */
	onSetUpEnvironment?: () => void;
	projectPickerOpen?: boolean;
	onProjectPickerOpenChange?: (open: boolean) => void;
	repairModel?: EnvironmentModelRequest;
	repairModelLabel?: string;
	/** The branch picked for a new chat; null keeps the default. */
	baseBranch?: string | null;
	onBaseBranchChange?: (branch: string) => void;
	/** The open chat's branch, shown read-only once it has started. */
	currentBranch?: string | null;
	/** The chat has no branch of its own (Y²): neither picker nor branch. */
	branchless?: boolean;
}) {
	return (
		<div
			className="session-context"
			// No project yet: the picker's pill sits alone, centered over the composer.
			data-empty={(!selectedProject && projects.length === 0) || undefined}
		>
			{projectLocked ? null : (
				<ProjectPicker
					projects={projects}
					selectedProject={selectedProject}
					onSelectProject={onSelectProject}
					open={projectPickerOpen}
					onOpenChange={onProjectPickerOpenChange}
				/>
			)}
			{branchless ? null : (
				<BaseBranchPicker
					project={selectedProject}
					value={baseBranch}
					onChange={(branch) => onBaseBranchChange?.(branch)}
					currentBranch={currentBranch}
					locked={projectLocked || !onBaseBranchChange}
				/>
			)}
			{/* Rerun setup lives in Settings > Environment, not in every chat. */}
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
