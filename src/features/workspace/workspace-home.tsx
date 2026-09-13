import { useQuery } from "@tanstack/react-query";
import { PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../../domain/projects";
import { authClient } from "../auth/client";
import { requestJson } from "../projects/api";
import { SessionLauncher } from "../sessions/session-launcher";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import { WorkspaceInspector } from "./workspace-inspector";

export function WorkspaceHome() {
	const compact = useCompactLayout();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: () => requestJson<Project[]>("/api/projects"),
	});
	const [selectedProjectId, setSelectedProjectId] = useState<string>();
	const selectedProject =
		projects.data?.find((project) => project.id === selectedProjectId) ??
		projects.data?.[0];
	const [projectsOpen, setProjectsOpen] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);

	useEffect(() => {
		if (compact) setProjectsOpen(false);
	}, [compact]);

	return (
		<div className="workspace-shell" data-projects-collapsed={!projectsOpen}>
			<ProjectSidebar
				projects={projects.data ?? []}
				selectedProjectId={selectedProject?.id}
				onSelectProject={setSelectedProjectId}
				expanded={projectsOpen}
				onToggle={() => setProjectsOpen((open) => !open)}
				onAddProject={() => {
					window.location.assign("/onboarding");
					if (compact) setProjectsOpen(false);
				}}
			/>
			<main className="workspace-main" inert={compact && projectsOpen}>
				<header className="workspace-header">
					<div className="header-navigation">
						<span>{selectedProject?.fullName ?? "Workspace"}</span>
					</div>
					<div className="header-tools">
						<button
							type="button"
							className="panel-toggle account-signout"
							onClick={async () => {
								await authClient.signOut();
								window.location.assign("/");
							}}
						>
							Sign out
						</button>
						<button
							type="button"
							className="panel-toggle inspector-toggle"
							aria-label={inspectorOpen ? "Hide tools" : "Show tools"}
							title={inspectorOpen ? "Hide tools" : "Show tools"}
							aria-expanded={inspectorOpen}
							aria-controls="workspace-inspector"
							onClick={() => setInspectorOpen((open) => !open)}
						>
							<PanelRight size={16} />
							<span>Tools</span>
						</button>
					</div>
				</header>
				<div
					className="workspace-body"
					data-inspector-collapsed={!inspectorOpen}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						inert={compact && inspectorOpen}
						aria-hidden={compact && inspectorOpen}
					>
						<div className="welcome-content">
							<SessionLauncher
								projects={projects.data ?? []}
								selectedProject={selectedProject}
								onSelectProject={setSelectedProjectId}
							/>
							{projects.isPending && <p role="status">Loading projects…</p>}
							{projects.error && (
								<p role="alert">
									Unable to load projects.{" "}
									<button type="button" onClick={() => void projects.refetch()}>
										Retry
									</button>
								</p>
							)}
							{!projects.isPending &&
								!projects.error &&
								!projects.data?.length && (
									<a className="setup-back" href="/onboarding">
										Add your first project
									</a>
								)}
						</div>
					</section>
					<div className="inspector-frame">
						<WorkspaceInspector collapsed={!inspectorOpen} />
					</div>
				</div>
			</main>
		</div>
	);
}
