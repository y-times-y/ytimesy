import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PanelRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	connectedAgentStatus,
	connectedProviderId,
} from "#/domain/agent-connection";
import type { AgentProviderId } from "#/domain/agent-provider";
import { hintForHarness } from "#/domain/harness-api-key";
import { fileChangesFromSessionItems } from "#/domain/session-item";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import type { Project } from "../../domain/projects";
import { authClient } from "../auth/client";
import { requestJson } from "../projects/api";
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
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: () => requestJson<Project[]>("/api/projects"),
	});
	const [selectedProjectId, setSelectedProjectId] = useState<string>();
	const selectedProject =
		projects.data?.find((project) => project.id === selectedProjectId) ??
		projects.data?.[0];
	const [session, setSession] = useState(initialSession);
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
	}, [loadKeys]);

	useEffect(() => {
		if (!selectedProject?.id) return;
		void getCodexSession({
			data: { projectId: selectedProject.id, harnessId },
		}).then(setSession);
		void loadDesktop({ data: { projectId: selectedProject.id } }).then(
			setDesktop,
		);
	}, [harnessId, loadDesktop, selectedProject?.id]);

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
			void getCodexSession({
				data: { projectId: selectedProject?.id, harnessId },
			}).then((next) => {
				setSession(next);
				if (next.sideTurnStatus !== "idle") setSideQueued(false);
			});
		}, interval);
		return () => window.clearInterval(timer);
	}, [
		selectedProject?.id,
		harnessId,
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
		void sendTask({
			data: {
				text,
				modelId,
				lane: "side",
				projectId: selectedProject?.id,
				harnessId,
			},
		})
			.then(setSession)
			.finally(() => setBusy(false));
	}

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
						{connectedProvider && agentStatus ? (
							<span className="header-agent-status">
								<AgentProviderMark provider={connectedProvider} size={16} />
								{agentStatus}
							</span>
						) : null}
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
					data-inspector-view={inspectorView}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						data-layout={chatLayout ? "chat" : "empty"}
						inert={compact && inspectorOpen}
						aria-hidden={compact && inspectorOpen}
					>
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
									void connect({
										data: {
											projectId: selectedProject?.id,
											harnessId,
										},
									})
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
											if (id === harnessId) {
												return connect({
													data: {
														projectId: selectedProject?.id,
														harnessId: id,
													},
												}).then(setSession);
											}
										})
										.finally(() => setBusy(false));
								}}
								onSend={(text, modelId) => {
									setBusy(true);
									void sendTask({
										data: {
											text,
											modelId,
											projectId: selectedProject?.id,
											harnessId,
										},
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onStop={() => {
									setBusy(true);
									void stopTurn({
										data: {
											projectId: selectedProject?.id,
											harnessId,
										},
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onOpenSideChat={(question) => {
									openSideChat();
									if (question) sendSideChat(question);
								}}
								onOpenInspector={openInspector}
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
							projectId={selectedProject?.id}
							onStartDesktop={() => {
								setDesktopBusy(true);
								setDesktop({ status: "starting" });
								void startDesktop({
									data: { projectId: selectedProject?.id },
								})
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
