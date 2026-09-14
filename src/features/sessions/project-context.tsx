import { GitBranch } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";

export function ProjectContext() {
	return (
		<div className="session-context">
			<Select>
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
					<SelectItem value="empty" disabled>
						No projects added yet
					</SelectItem>
				</SelectContent>
			</Select>
			<Select disabled>
				<SelectTrigger
					className="context-select branch-select"
					aria-label="Branch"
				>
					<SelectValue placeholder="Branch" />
				</SelectTrigger>
			</Select>
		</div>
	);
}
