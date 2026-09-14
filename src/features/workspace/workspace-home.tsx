import { useServerFn } from "@tanstack/react-start";
import { PanelRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	connectedAgentStatus,
	connectedProviderId,
} from "#/domain/agent-connection";
import type { AgentProviderId } from "#/domain/agent-provider";
import { hintForHarness } from "#/domain/harness-api-key";
import {
	fileChangesFromSessionItems,
	sessionTitleFromItems,
} from "#/domain/session-item";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { AgentProviderMark } from "../sessions/agent-provider-mark";
import {
	connectCodexSession,
	getCodexSession,
	sendCodexSessionTask,
	stopCodexSessionTurn,
} from "../sessions/codex-session.fn";
import {
	getHarnessApiKeys,
	saveHarnessApiKeyFn,
} from "../sessions/harness-key.fn";
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "../sessions/model-capabilities";
import { SessionLauncher } from "../sessions/session-launcher";
import { SideChatPanel } from "../sessions/side-chat-panel";
import { getWorkspaceDesktop, startWorkspaceDesktopFn } from "./desktop.fn";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import {
	type InspectorView,
	type ToolsView,
	WorkspaceInspector,
} from "./workspace-inspector";

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
	const [toolsView, setToolsView] = useState<ToolsView>("diff");
	const [inspectorView, setInspectorView] = useState<InspectorView>("diff");
	const [sideChatOpen, setSideChatOpen] = useState(false);
	const [sideQueued, setSideQueued] = useState(false);
	const [busy, setBusy] = useState(false);
	const [harnessId, setHarnessId] = useState<AgentProviderId>("codex");
	const [apiKeyHints, setApiKeyHints] = useState<
		Partial<Record<AgentProviderId, string>>
	>({});
	const [desktop, setDesktop] = useState<WorkspaceDesktop>({
		status: "stopped",
	});
	const [desktopBusy, setDesktopBusy] = useState(false);
	const connect = useServerFn(connectCodexSession);
	const sendTask = useServerFn(sendCodexSessionTask);
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const loadKeys = useServerFn(getHarnessApiKeys);
	const saveKey = useServerFn(saveHarnessApiKeyFn);
	const loadDesktop = useServerFn(getWorkspaceDesktop);
	const startDesktop = useServerFn(startWorkspaceDesktopFn);
	const fileChanges = fileChangesFromSessionItems(session.items);
	const openedDiff = useRef(false);
	const chatLayout =
		session.connection.status === "authenticated" || session.items.length > 0;
	const agentStatus = connectedAgentStatus(session.connection);
	const connectedProvider = connectedProviderId(session.connection);
	const sessionTitle = sessionTitleFromItems(session.items);

	useEffect(() => {
		if (compact) setProjectsOpen(false);
	}, [compact]);

	useEffect(() => {
		void loadKeys().then((status) => {
			setApiKeyHints({
				codex: hintForHarness(status.keys, "codex") ?? undefined,
				claude: hintForHarness(status.keys, "claude") ?? undefined,
				opencode: hintForHarness(status.keys, "opencode") ?? undefined,
			});
		});
		void loadDesktop().then(setDesktop);
	}, [loadDesktop, loadKeys]);

	useEffect(() => {
		if (!chatLayout) return;
		setInspectorOpen(true);
	}, [chatLayout]);

	useEffect(() => {
		if (compact || openedDiff.current || fileChanges.length === 0) return;
		openedDiff.current = true;
		setToolsView("diff");
		setInspectorView("diff");
		setInspectorOpen(true);
	}, [compact, fileChanges.length]);

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

	function openInspector(view: ToolsView) {
		setToolsView(view);
		setInspectorView(view);
		setInspectorOpen(true);
	}

	function openSideChat() {
		setSideChatOpen(true);
		setInspectorView("side");
		setInspectorOpen(true);
	}

	function closeSideChat() {
		setSideChatOpen(false);
		setInspectorView(toolsView);
	}

	function sendSideChat(text: string) {
		const modelId = sessionModelId(session);
		if (!modelId) return;
		if (session.turnStatus === "running") setSideQueued(true);
		setBusy(true);
		void sendTask({ data: { text, modelId, lane: "side" } })
			.then(setSession)
			.finally(() => setBusy(false));
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
				<div
					className="workspace-body"
					data-inspector-collapsed={!inspectorOpen}
					data-inspector-view={inspectorView}
					data-layout={chatLayout ? "chat" : "empty"}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						data-layout={chatLayout ? "chat" : "empty"}
						inert={compact && inspectorOpen}
						aria-hidden={compact && inspectorOpen}
					>
						{chatLayout ? (
							<div className="session-title-row">
								<div className="session-title-copy">
									<span className="session-title">{sessionTitle}</span>
									{connectedProvider && agentStatus ? (
										<span className="header-agent-status">
											<AgentProviderMark
												provider={connectedProvider}
												size={14}
											/>
											{agentStatus}
										</span>
									) : null}
								</div>
								{inspectorOpen ? null : (
									<button
										type="button"
										className="panel-toggle inspector-toggle"
										aria-label="Show tools"
										title="Show tools"
										aria-expanded={false}
										aria-controls="workspace-inspector"
										onClick={() => setInspectorOpen(true)}
									>
										<PanelRight size={16} />
										<span>Tools</span>
									</button>
								)}
							</div>
						) : inspectorOpen ? null : (
							<div className="session-title-row session-title-row-empty">
								<div className="session-title-copy" />
								<button
									type="button"
									className="panel-toggle inspector-toggle"
									aria-label="Show tools"
									title="Show tools"
									aria-expanded={false}
									aria-controls="workspace-inspector"
									onClick={() => setInspectorOpen(true)}
								>
									<PanelRight size={16} />
									<span>Tools</span>
								</button>
							</div>
						)}
						<div
							className="welcome-content"
							data-layout={chatLayout ? "chat" : "empty"}
						>
							<SessionLauncher
								session={session}
								busy={busy}
								harnessId={harnessId}
								onHarnessIdChange={setHarnessId}
								apiKeyHints={apiKeyHints}
								onConnect={() => {
									setBusy(true);
									void connect()
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onSaveApiKey={(id, apiKey) => {
									setBusy(true);
									void saveKey({ data: { harnessId: id, apiKey } })
										.then((status) => {
											setApiKeyHints({
												codex:
													hintForHarness(status.keys, "codex") ?? undefined,
												claude:
													hintForHarness(status.keys, "claude") ?? undefined,
												opencode:
													hintForHarness(status.keys, "opencode") ?? undefined,
											});
										})
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
									if (question) sendSideChat(question);
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
					<div className="inspector-frame">
						<WorkspaceInspector
							collapsed={!inspectorOpen}
							activeView={inspectorView}
							onActiveViewChange={(view) => {
								if (view !== "side") setToolsView(view);
								setInspectorView(view);
							}}
							fileChanges={fileChanges}
							desktop={desktop}
							desktopBusy={desktopBusy}
							onStartDesktop={() => {
								setDesktopBusy(true);
								setDesktop({ status: "starting" });
								void startDesktop()
									.then(setDesktop)
									.finally(() => setDesktopBusy(false));
							}}
							sideChatOpen={sideChatOpen}
							onNewSideChat={openSideChat}
							onCloseSideChat={closeSideChat}
							sideChat={
								<SideChatPanel
									items={session.sideItems}
									turnStatus={session.sideTurnStatus}
									canSend={session.canSendSide}
									mainTurnRunning={session.turnStatus === "running"}
									busy={busy}
									queued={sideQueued}
									onSend={sendSideChat}
								/>
							}
							onCollapse={() => setInspectorOpen(false)}
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
