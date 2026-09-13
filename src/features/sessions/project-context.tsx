import { GitBranch } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { Project } from "../../domain/projects";

export function ProjectContext({
	projects,
	selectedProject,
	onSelectProject,
}: {
	projects: Project[];
	selectedProject?: Project;
	onSelectProject: (id: string) => void;
}) {
	return (
		<div className="session-context">
			<Select value={selectedProject?.id ?? ""} onValueChange={onSelectProject}>
				<SelectTrigger
					className="context-select project-select"
					aria-label="Project"
				>
					<GitBranch size={18} />
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
			<Select disabled>
				<SelectTrigger
					className="context-select branch-select"
					aria-label="Branch"
				>
					<span>{selectedProject?.branch ?? "Branch"}</span>
				</SelectTrigger>
			</Select>
		</div>
	);
}
