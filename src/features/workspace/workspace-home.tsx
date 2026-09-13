import { useServerFn } from "@tanstack/react-start";
import { PanelRight } from "lucide-react";
import { useEffect, useState } from "react";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	connectCodexSession,
	getCodexSession,
	sendCodexSessionTask,
} from "../sessions/codex-session.fn";
import { SessionLauncher } from "../sessions/session-launcher";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import { WorkspaceInspector } from "./workspace-inspector";

export function WorkspaceHome({
	initialSession,
}: {
	initialSession: PublicCodexSession;
}) {
	const compact = useCompactLayout();
	const [session, setSession] = useState(initialSession);
	const [showSetup, setShowSetup] = useState(false);
	const [projectsOpen, setProjectsOpen] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const connect = useServerFn(connectCodexSession);
	const sendTask = useServerFn(sendCodexSessionTask);

	useEffect(() => {
		if (compact) setProjectsOpen(false);
	}, [compact]);

	useEffect(() => {
		if (session.connection.status !== "awaiting_device_code") return;
		const timer = window.setInterval(() => {
			void getCodexSession().then(setSession);
		}, 3000);
		return () => window.clearInterval(timer);
	}, [session.connection.status]);

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
							<SessionLauncher
								session={session}
								busy={busy}
								onConnect={() => {
									setBusy(true);
									void connect()
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onSend={(text, modelId) => {
									setBusy(true);
									void sendTask({ data: { text, modelId } })
										.then(setSession)
										.finally(() => setBusy(false));
								}}
							/>
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
