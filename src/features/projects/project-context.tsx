import { GitBranch } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { PublicProjectPicker } from "#/domain/github-project";

export function ProjectContext({
	picker,
	busy,
	onSelectProject,
	onSelectBranch,
}: {
	picker: PublicProjectPicker | null;
	busy: boolean;
	onSelectProject: (projectId: string) => void;
	onSelectBranch: (branch: string) => void;
}) {
	const projects = picker?.projects ?? [];
	const branches = picker?.branches ?? [];
	const selectedProjectId = picker?.selectedProjectId ?? undefined;
	const selectedBranch = picker?.selectedBranch ?? undefined;
	const emptyCopy = picker
		? (picker.message ?? "No projects added yet")
		: "Loading projects…";
	const branchDisabled = busy || !selectedProjectId;
	const projectDisabled = busy || !picker;

	return (
		<div className="session-context">
			<Select
				value={selectedProjectId}
				onValueChange={onSelectProject}
				disabled={projectDisabled}
			>
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
					{projects.length === 0 ? (
						<SelectItem value="empty" disabled>
							{emptyCopy}
						</SelectItem>
					) : (
						projects.map((project) => (
							<SelectItem key={project.projectId} value={project.projectId}>
								{project.fullName}
							</SelectItem>
						))
					)}
				</SelectContent>
			</Select>
			<Select
				value={selectedBranch}
				onValueChange={onSelectBranch}
				disabled={branchDisabled}
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
					{branches.length === 0 ? (
						<SelectItem value="empty" disabled>
							{selectedProjectId ? "Loading branches…" : "Branch"}
						</SelectItem>
					) : (
						branches.map((branch) => (
							<SelectItem key={branch} value={branch}>
								{branch}
							</SelectItem>
						))
					)}
				</SelectContent>
			</Select>
		</div>
	);
}
