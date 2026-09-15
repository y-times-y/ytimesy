import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { PanelRight } from "lucide-react";
import {
	type PointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	connectedAgentStatus,
	connectedProviderId,
} from "#/domain/agent-connection";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import { hintForHarness } from "#/domain/harness-api-key";
import {
	inspectorSplitFromPointer,
	inspectorSplitRatio,
	nudgeInspectorSplit,
} from "#/domain/inspector-split";
import type { Project } from "#/domain/projects";
import {
	fileChangesFromSessionItems,
	lastUserMessageText,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
} from "#/domain/session-item";
import { selectedChatIdAfterDelete } from "#/domain/sidebar-chats";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { authClient } from "../auth/client";
import { requestJson } from "../projects/api";
import { AgentProviderMark } from "../sessions/agent-provider-mark";
import {
	deleteProjectAgentSession,
	listProjectAgentSessions,
	startProjectAgentSession,
} from "../sessions/agent-session.fn";
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
import { useCompactLayout, useInspectorBesideChat } from "./use-compact-layout";
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
	const inspectorBeside = useInspectorBesideChat();
	const queryClient = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: () => requestJson<Project[]>("/api/projects"),
	});
	const [selectedProjectId, setSelectedProjectId] = useState<string>();
	const selectedProject =
		projects.data?.find((project) => project.id === selectedProjectId) ??
		projects.data?.[0];
	const [selectedSessionId, setSelectedSessionId] = useState<string>();
	const [session, setSession] = useState(initialSession);
	const chats = useQuery({
		queryKey: ["agent-sessions", selectedProject?.id],
		queryFn: () =>
			listProjectAgentSessions({
				data: { projectId: selectedProject?.id },
			}),
		enabled: Boolean(selectedProject?.id),
	});
	const startSession = useServerFn(startProjectAgentSession);
	const deleteSession = useServerFn(deleteProjectAgentSession);
	const [projectsOpen, setProjectsOpen] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [toolsView, setToolsView] = useState<ToolsView>("diff");
	const [inspectorView, setInspectorView] = useState<InspectorView>("diff");
	const [customSplit, setCustomSplit] = useState<number | null>(null);
	const [splitting, setSplitting] = useState(false);
	const workspaceBody = useRef<HTMLDivElement>(null);
	const [sideChatOpen, setSideChatOpen] = useState(false);
	const [sideQueued, setSideQueued] = useState(false);
	const [busy, setBusy] = useState(false);
	const [harnessId, setHarnessId] = useState<AgentProviderId>(
		DEFAULT_COMPOSER_HARNESS_ID,
	);
	const [apiKeyHints, setApiKeyHints] = useState<
		Partial<Record<AgentProviderId, string>>
	>({});
	const [desktop, setDesktop] = useState<WorkspaceDesktop>({
		status: "stopped",
	});
	const [desktopBusy, setDesktopBusy] = useState(false);
	const autoResumeStarted = useRef(false);
	const desktopAutoStarted = useRef(false);
	const sessionEpoch = useRef(0);
	const bumpSessionEpoch = useCallback(() => {
		sessionEpoch.current += 1;
		return sessionEpoch.current;
	}, []);
	const applySessionView = useCallback(
		(epoch: number, next: PublicCodexSession) => {
			if (epoch !== sessionEpoch.current) return;
			setSession(next);
			if (next.agentSessionId) setSelectedSessionId(next.agentSessionId);
		},
		[],
	);
	const connect = useServerFn(connectCodexSession);
	const sendTask = useServerFn(sendCodexSessionTask);
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const loadKeys = useServerFn(getHarnessApiKeys);
	const saveKey = useServerFn(saveHarnessApiKeyFn);
	const loadDesktop = useServerFn(getWorkspaceDesktop);
	const startDesktop = useServerFn(startWorkspaceDesktopFn);
	const fileChanges = fileChangesFromSessionItems(session.items);
	const openedDiff = useRef(false);
	const followUpLayout = sessionUsesFollowUpLayout({
		items: session.items,
		turnStatus: session.turnStatus,
	});
	const splitRatio = inspectorSplitRatio({
		custom: customSplit,
		desktop: inspectorView === "desktop",
	});
	const agentStatus = connectedAgentStatus(session.connection);
	const connectedProvider = connectedProviderId(session.connection);
	const sessionTitle = sessionTitleFromItems(session.items);
	const hasUserMessage = Boolean(lastUserMessageText(session.items));
	const sidebarChats = chats.data ?? [];
	const activeProjectId = selectedProject?.id;
	const activeSessionId =
		selectedSessionId ?? session.agentSessionId ?? undefined;

	function sessionScope() {
		return {
			projectId: activeProjectId,
			harnessId,
			sessionId: activeSessionId,
		};
	}

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
		void activeProjectId;
		setSelectedSessionId(undefined);
		desktopAutoStarted.current = false;
		autoResumeStarted.current = false;
	}, [activeProjectId]);

	useEffect(() => {
		if (selectedSessionId || !chats.data?.[0]) return;
		setSelectedSessionId(chats.data[0].id);
	}, [chats.data, selectedSessionId]);

	useEffect(() => {
		if (!activeProjectId) return;
		void loadDesktop({
			data: { projectId: activeProjectId, sessionId: activeSessionId },
		}).then((next) => {
			setDesktop((current) =>
				current.status === "starting" || current.status === "running"
					? current
					: next,
			);
		});
	}, [loadDesktop, activeProjectId, activeSessionId]);

	useEffect(() => {
		if (!activeProjectId || busy) return;
		const epoch = sessionEpoch.current;
		void getCodexSession({
			data: {
				projectId: activeProjectId,
				harnessId,
				sessionId: activeSessionId,
			},
		}).then((next) => applySessionView(epoch, next));
	}, [applySessionView, busy, harnessId, activeProjectId, activeSessionId]);

	useEffect(() => {
		if (session.connection.status !== "authenticated") return;
		setInspectorOpen(true);
	}, [session.connection.status]);

	useEffect(() => {
		if (compact || openedDiff.current || fileChanges.length === 0) return;
		openedDiff.current = true;
		setToolsView("diff");
		setInspectorView("diff");
		setInspectorOpen(true);
	}, [compact, fileChanges.length]);

	useEffect(() => {
		if (autoResumeStarted.current) return;
		if (!activeProjectId) return;
		if (harnessId === "claude") return;
		const shouldConnect =
			session.connection.status === "authenticated" ||
			(harnessId === "codex" &&
				session.snapshotAvailable &&
				session.connection.status === "disconnected") ||
			(harnessId === "opencode" &&
				Boolean(activeSessionId) &&
				session.connection.status === "disconnected");
		if (!shouldConnect) return;
		autoResumeStarted.current = true;
		setBusy(true);
		const epoch = sessionEpoch.current;
		void connect({
			data: {
				projectId: activeProjectId,
				harnessId,
				sessionId: activeSessionId,
			},
		})
			.then((next) => applySessionView(epoch, next))
			.finally(() => setBusy(false));
	}, [
		applySessionView,
		connect,
		harnessId,
		activeProjectId,
		activeSessionId,
		session.connection.status,
		session.snapshotAvailable,
	]);

	useEffect(() => {
		if (session.connection.status !== "authenticated") return;
		if (!activeProjectId) return;
		if (desktopAutoStarted.current) return;
		if (desktop.status === "running" || desktop.status === "starting") return;
		desktopAutoStarted.current = true;
		setDesktopBusy(true);
		setDesktop({ status: "starting" });
		void startDesktop({
			data: { projectId: activeProjectId, sessionId: activeSessionId },
		})
			.then(setDesktop)
			.finally(() => setDesktopBusy(false));
	}, [
		desktop.status,
		activeProjectId,
		activeSessionId,
		session.connection.status,
		startDesktop,
	]);

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
		const epoch = sessionEpoch.current;
		const timer = window.setInterval(() => {
			void getCodexSession({
				data: {
					projectId: activeProjectId,
					harnessId,
					sessionId: activeSessionId,
				},
			}).then((next) => {
				if (epoch !== sessionEpoch.current) return;
				setSession(next);
				if (next.sideTurnStatus !== "idle") setSideQueued(false);
			});
		}, interval);
		return () => window.clearInterval(timer);
	}, [
		activeProjectId,
		activeSessionId,
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

	function focusProjectPicker() {
		document
			.querySelector<HTMLButtonElement>('[aria-label="Project"]')
			?.click();
	}

	function startNewChat() {
		if (!selectedProject) {
			setProjectsOpen(true);
			requestAnimationFrame(focusProjectPicker);
			return;
		}
		setBusy(true);
		const epoch = bumpSessionEpoch();
		void startSession({
			data: { projectId: selectedProject.id, harnessId },
		})
			.then((created) => {
				setSelectedSessionId(created.id);
				desktopAutoStarted.current = false;
				autoResumeStarted.current = false;
				openedDiff.current = false;
				setDesktop({ status: "stopped" });
				setSession((current) => ({
					...current,
					agentSessionId: created.id,
					items: [],
					turnStatus: "idle",
					sideItems: [],
					sideTurnStatus: "idle",
				}));
				void chats.refetch();
				return connect({
					data: { ...sessionScope(), sessionId: created.id, createNew: false },
				});
			})
			.then((next) => {
				if (next) applySessionView(epoch, next);
			})
			.catch((cause) => {
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: harnessId,
						message: cause instanceof Error ? cause.message : String(cause),
					},
					canSend: false,
					canSendSide: false,
				}));
			})
			.finally(() => setBusy(false));
	}

	function deleteChat(chatId: string) {
		if (!selectedProject) {
			return;
		}
		const remaining = sidebarChats.filter((chat) => chat.id !== chatId);
		queryClient.setQueryData(["agent-sessions", selectedProject.id], remaining);
		const nextId = selectedChatIdAfterDelete({
			chats: sidebarChats,
			selectedChatId: activeSessionId,
			deletedChatId: chatId,
		});
		if (activeSessionId === chatId) {
			bumpSessionEpoch();
			setSelectedSessionId(nextId);
			desktopAutoStarted.current = false;
			autoResumeStarted.current = false;
			openedDiff.current = false;
			setDesktop({ status: "stopped" });
			setSession((current) => ({
				...current,
				agentSessionId: nextId ?? null,
				items: [],
				turnStatus: "idle",
				sideItems: [],
				sideTurnStatus: "idle",
				connection: { status: "disconnected" },
				canSend: false,
				canSendSide: false,
			}));
		}
		setBusy(true);
		void deleteSession({
			data: { projectId: selectedProject.id, sessionId: chatId },
		})
			.then(() => chats.refetch())
			.catch((cause) => {
				void chats.refetch();
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: harnessId,
						message: cause instanceof Error ? cause.message : String(cause),
					},
					canSend: false,
					canSendSide: false,
				}));
			})
			.finally(() => setBusy(false));
	}

	async function signOut() {
		await authClient.signOut();
		window.location.assign("/");
	}

	function sendSideChat(text: string) {
		const modelId = sessionModelId(session);
		if (!modelId) return;
		if (harnessId === "codex" && session.turnStatus === "running")
			setSideQueued(true);
		setBusy(true);
		void sendTask({
			data: { ...sessionScope(), text, modelId, lane: "side" as const },
		})
			.then(setSession)
			.finally(() => setBusy(false));
	}

	function beginInspectorSplit(event: PointerEvent<HTMLButtonElement>) {
		if (!inspectorBeside) return;
		event.preventDefault();
		const body = workspaceBody.current;
		if (!body) return;
		const handle = event.currentTarget;
		handle.setPointerCapture(event.pointerId);
		const bounds = body.getBoundingClientRect();
		setSplitting(true);
		function move(next: globalThis.PointerEvent) {
			setCustomSplit(
				inspectorSplitFromPointer({
					clientX: next.clientX,
					originX: bounds.left,
					width: bounds.width,
				}),
			);
		}
		function stop() {
			setSplitting(false);
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", stop);
		}
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", stop);
	}

	return (
		<div className="workspace-shell" data-projects-collapsed={!projectsOpen}>
			<ProjectSidebar
				projects={projects.data ?? []}
				projectsLoading={projects.isPending}
				selectedProjectId={selectedProject?.id}
				onSelectProject={setSelectedProjectId}
				expanded={projectsOpen}
				onToggle={() => setProjectsOpen((open) => !open)}
				onAddProject={() => {
					window.location.assign("/onboarding");
					if (compact) setProjectsOpen(false);
				}}
				chats={sidebarChats}
				selectedChatId={activeSessionId}
				hasUserMessage={hasUserMessage}
				onSelectChat={(id) => {
					bumpSessionEpoch();
					setSelectedSessionId(id);
					desktopAutoStarted.current = false;
					autoResumeStarted.current = false;
					openedDiff.current = false;
					setDesktop({ status: "stopped" });
					setSession((current) => ({
						...current,
						agentSessionId: id,
						items: [],
						turnStatus: "idle",
					}));
				}}
				onNewChat={startNewChat}
				onDeleteChat={deleteChat}
				onSignOut={() => {
					void signOut();
				}}
			/>
			<main className="workspace-main" inert={compact && projectsOpen}>
				<div
					ref={workspaceBody}
					className="workspace-body"
					data-inspector-collapsed={!inspectorOpen}
					data-inspector-view={inspectorView}
					data-layout={followUpLayout ? "chat" : "empty"}
					data-splitting={splitting ? "true" : undefined}
					style={
						inspectorOpen && inspectorBeside
							? {
									gridTemplateColumns: `${splitRatio}fr ${1 - splitRatio}fr`,
								}
							: undefined
					}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						data-layout={followUpLayout ? "chat" : "empty"}
						inert={compact && inspectorOpen}
						aria-hidden={compact && inspectorOpen}
					>
						{followUpLayout ? (
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
							data-layout={followUpLayout ? "chat" : "empty"}
						>
							<SessionLauncher
								session={session}
								busy={busy}
								harnessId={harnessId}
								onHarnessIdChange={(id) => {
									setHarnessId(id);
									if (id !== "opencode") return;
									setBusy(true);
									void connect({
										data: { ...sessionScope(), harnessId: id },
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								apiKeyHints={apiKeyHints}
								onConnect={() => {
									setBusy(true);
									void connect({
										data: sessionScope(),
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
													data: { ...sessionScope(), harnessId: id },
												}).then(setSession);
											}
										})
										.finally(() => setBusy(false));
								}}
								onSend={(text, modelId) => {
									setBusy(true);
									void sendTask({
										data: { ...sessionScope(), text, modelId },
									})
										.then(setSession)
										.finally(() => setBusy(false));
								}}
								onStop={() => {
									setBusy(true);
									void stopTurn({
										data: sessionScope(),
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
						{inspectorOpen && inspectorBeside ? (
							<button
								type="button"
								className="inspector-split"
								aria-label="Resize tools panel"
								title="Drag to resize. Double-click to reset."
								onPointerDown={beginInspectorSplit}
								onDoubleClick={() => setCustomSplit(null)}
								onKeyDown={(event) => {
									if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
										return;
									}
									event.preventDefault();
									setCustomSplit(
										nudgeInspectorSplit(
											splitRatio,
											event.key === "ArrowLeft" ? -1 : 1,
										),
									);
								}}
							/>
						) : null}
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
							sessionId={activeSessionId}
							onStartDesktop={() => {
								setDesktopBusy(true);
								setDesktop({ status: "starting" });
								void startDesktop({
									data: {
										projectId: selectedProject?.id,
										sessionId: activeSessionId,
									},
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
									isolated={harnessId !== "codex"}
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
