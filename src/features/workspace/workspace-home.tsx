import { PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionLauncher } from "../sessions/session-launcher";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import { WorkspaceInspector } from "./workspace-inspector";

export function WorkspaceHome() {
	const compact = useCompactLayout();
	const [showSetup, setShowSetup] = useState(false);
	const [projectsOpen, setProjectsOpen] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);

	useEffect(() => {
		if (compact) setProjectsOpen(false);
	}, [compact]);

	return (
		<div className="workspace-shell" data-projects-collapsed={!projectsOpen}>
			<ProjectSidebar
				expanded={projectsOpen}
				onToggle={() => setProjectsOpen((open) => !open)}
				onAddProject={() => {
					setShowSetup(true);
					if (compact) setProjectsOpen(false);
				}}
			/>
			<main className="workspace-main" inert={compact && projectsOpen}>
				<header className="workspace-header">
					<div className="header-navigation">
						<span>Workspace</span>
					</div>
					<div className="header-tools">
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
							<SessionLauncher />
							{showSetup && (
								<div className="project-setup-notice" role="status">
									<p>Project setup isn’t available yet.</p>
									<button type="button" onClick={() => setShowSetup(false)}>
										Dismiss
									</button>
								</div>
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
