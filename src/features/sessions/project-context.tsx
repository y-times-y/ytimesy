import { useMutation } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { Project } from "../../domain/projects";
import { requestJson } from "../projects/api";
import { WorkspaceStatus } from "../projects/workspace-status";

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
			{selectedProject && <WorkspaceStatus projectId={selectedProject.id} />}
			{selectedProject && (
				<PublicationAction
					key={selectedProject.id}
					projectId={selectedProject.id}
				/>
			)}
		</div>
	);
}

function PublicationAction({ projectId }: { projectId: string }) {
	const [title, setTitle] = useState("");
	const publish = useMutation({
		mutationFn: () =>
			requestJson<{ url: string; number: number; draft: boolean }>(
				"/api/projects/publish",
				{ projectId, title },
			),
	});
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
			{publish.error && <p role="alert">{publish.error.message}</p>}
		</form>
	);
}
