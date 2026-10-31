import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import type { EnvironmentModelRequest } from "#/domain/environment-model";
import type { Project } from "../../domain/projects";
import { getProjectEnvironmentFn } from "../projects/environment.fn";
import { WorkspaceStatus } from "../projects/workspace-status";
import { environmentQueryKey } from "../workspace/environment-settings";
import { BaseBranchPicker } from "./base-branch-picker";
import { ProjectPicker } from "./project-picker";

export function ProjectContext({
	projects,
	selectedProject,
	onSelectProject,
	projectLocked = false,
	onSetUpEnvironment,
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
	/** Starts the environment setup; shown on a new chat until a setup is saved. */
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
			{selectedProject && onSetUpEnvironment && !projectLocked ? (
				<SetUpEnvironmentChip
					projectId={selectedProject.id}
					onSetUp={onSetUpEnvironment}
				/>
			) : null}
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

/** "Set up environment", until one of the project's repositories has a saved setup. */
function SetUpEnvironmentChip({
	projectId,
	onSetUp,
}: {
	projectId: string;
	onSetUp: () => void;
}) {
	const read = useServerFn(getProjectEnvironmentFn);
	const environment = useQuery({
		queryKey: environmentQueryKey(projectId),
		queryFn: () => read({ data: { projectId } }),
		staleTime: 60_000,
	});
	if (!environment.data) return null;
	if (environment.data.repositories.some((repo) => repo.saved)) return null;
	return (
		<button type="button" className="environment-chip" onClick={onSetUp}>
			<Sparkles size={13} />
			Set up environment
		</button>
	);
}
