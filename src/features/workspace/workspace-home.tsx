import { useServerFn } from "@tanstack/react-start";
import { PanelRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { fileChangesFromSessionItems } from "#/domain/session-item";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	connectCodexSession,
	getCodexSession,
	sendCodexSessionTask,
	stopCodexSessionTurn,
} from "../sessions/codex-session.fn";
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "../sessions/model-capabilities";
import { SessionLauncher } from "../sessions/session-launcher";
import { SideChatPanel } from "../sessions/side-chat-panel";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import { type InspectorView, WorkspaceInspector } from "./workspace-inspector";

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
	const [inspectorView, setInspectorView] = useState<InspectorView>("diff");
	const [sideChatOpen, setSideChatOpen] = useState(false);
	const [sideQueued, setSideQueued] = useState(false);
	const [busy, setBusy] = useState(false);
	const connect = useServerFn(connectCodexSession);
	const sendTask = useServerFn(sendCodexSessionTask);
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const fileChanges = fileChangesFromSessionItems(session.items);
	const chatLayout =
		session.connection.status === "authenticated" || session.items.length > 0;
	const agentLabel =
		session.connection.status === "authenticated"
			? `Codex${session.connection.planType ? ` · ${session.connection.planType}` : ""}`
			: null;

	useEffect(() => {
		if (compact) setProjectsOpen(false);
	}, [compact]);

	useEffect(() => {
		if (
			session.connection.status !== "awaiting_device_code" &&
			session.turnStatus !== "running" &&
			session.sideTurnStatus !== "running" &&
			!sideQueued
		) {
			return;
		}
		const interval =
			session.turnStatus === "running" ||
			session.sideTurnStatus === "running" ||
			sideQueued
				? 1000
				: 3000;
		const timer = window.setInterval(() => {
			void getCodexSession().then((next) => {
				setSession(next);
				if (next.sideTurnStatus !== "idle") setSideQueued(false);
			});
		}, interval);
		return () => window.clearInterval(timer);
	}, [
		session.connection.status,
		session.sideTurnStatus,
		session.turnStatus,
		sideQueued,
	]);

	function openInspector(view: InspectorView) {
		setInspectorView(view);
		setInspectorOpen(true);
	}

	function openSideChat() {
		setSideChatOpen(true);
	}

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
						{agentLabel ? (
							<span className="header-agent-status">{agentLabel}</span>
						) : null}
					</div>
					<div className="header-tools">
						<button
							type="button"
							className="panel-toggle inspector-toggle"
							aria-label="New side chat"
							title="New side chat"
							aria-pressed={sideChatOpen}
							onClick={() => setSideChatOpen((open) => !open)}
						>
							<Plus size={16} />
							<span>Side</span>
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
					data-side-chat={sideChatOpen}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						data-layout={chatLayout ? "chat" : "empty"}
						inert={compact && (inspectorOpen || sideChatOpen)}
						aria-hidden={compact && (inspectorOpen || sideChatOpen)}
					>
						<div
							className="welcome-content"
							data-layout={chatLayout ? "chat" : "empty"}
						>
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
								onStop={() => {
									setBusy(true);
									void stopTurn()
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onOpenSideChat={(question) => {
									openSideChat();
									if (!question) return;
									const modelId = sessionModelId(session);
									if (!modelId) return;
									setBusy(true);
									if (session.turnStatus === "running") setSideQueued(true);
									void sendTask({
										data: { text: question, modelId, lane: "side" },
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onOpenInspector={openInspector}
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
					<div className="side-chat-frame" inert={!sideChatOpen}>
						{sideChatOpen ? (
							<SideChatPanel
								items={session.sideItems}
								turnStatus={session.sideTurnStatus}
								canSend={session.canSendSide}
								mainTurnRunning={session.turnStatus === "running"}
								busy={busy}
								queued={sideQueued}
								onClose={() => setSideChatOpen(false)}
								onSend={(text) => {
									const modelId = sessionModelId(session);
									if (!modelId) return;
									if (session.turnStatus === "running") setSideQueued(true);
									setBusy(true);
									void sendTask({
										data: { text, modelId, lane: "side" },
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
							/>
						) : null}
					</div>
					<div className="inspector-frame">
						<WorkspaceInspector
							collapsed={!inspectorOpen}
							activeView={inspectorView}
							onActiveViewChange={setInspectorView}
							fileChanges={fileChanges}
						/>
					</div>
				</div>
			</main>
		</div>
	);
}

function sessionModelId(session: PublicCodexSession): string {
	return preferredSessionModelId(sessionModelsFromListed(session.models));
}
