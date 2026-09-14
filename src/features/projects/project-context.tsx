import { FolderGit2, GitBranch } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import {
	type PublicProjectPicker,
	projectPickerLabel,
} from "#/domain/github-project";

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
	const selectedProjectId = picker?.selectedProjectId ?? null;
	const selectedBranch = picker?.selectedBranch ?? null;
	const projectValue = selectedProjectId ?? "none";
	const branchValue = selectedBranch ?? "none";
	const emptyCopy = picker
		? (picker.message ?? "No repositories yet")
		: "Loading repositories…";
	const branchDisabled = busy || !selectedProjectId;
	const projectDisabled = busy || !picker;

	return (
		<div className="session-context">
			<Select
				value={projectValue}
				onValueChange={(value) => {
					if (value === "none") return;
					if (value === "add-repo") {
						if (picker?.installUrl) {
							window.open(picker.installUrl, "_blank", "noopener,noreferrer");
						}
						return;
					}
					onSelectProject(value);
				}}
				disabled={projectDisabled}
			>
				<SelectTrigger
					className="context-select project-select"
					aria-label="Project"
				>
					<FolderGit2 size={14} />
					<SelectValue placeholder="Select a repository" />
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="top"
					align="start"
					sideOffset={8}
				>
					{projects.length === 0 ? (
						<SelectItem value="none" disabled>
							{emptyCopy}
						</SelectItem>
					) : (
						projects.map((project) => (
							<SelectItem key={project.projectId} value={project.projectId}>
								{projectPickerLabel(project, projects)}
							</SelectItem>
						))
					)}
					{picker?.installUrl ? (
						<SelectItem value="add-repo">Add repository…</SelectItem>
					) : null}
				</SelectContent>
			</Select>
			<Select
				value={branchValue}
				onValueChange={(value) => {
					if (value === "none") return;
					onSelectBranch(value);
				}}
				disabled={branchDisabled}
			>
				<SelectTrigger
					className="context-select branch-select"
					aria-label="Branch"
				>
					<GitBranch size={14} />
					<SelectValue placeholder="Branch" />
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="top"
					align="start"
					sideOffset={8}
				>
					{branches.length === 0 ? (
						<SelectItem value="none" disabled>
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
