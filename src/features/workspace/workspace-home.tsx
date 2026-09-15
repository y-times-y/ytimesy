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
import {
	RUNNING_TURN_POLL_MS,
	runningAuthenticatedTurnShouldPoll,
	shouldAutoResumeHarnessSession,
} from "#/domain/harness-access";
import { hintForHarness } from "#/domain/harness-api-key";
import {
	inspectorSplitFromPointer,
	inspectorSplitRatio,
	nudgeInspectorSplit,
} from "#/domain/inspector-split";
import { publicFailureMessage } from "#/domain/project-workspace";
import type { Project } from "#/domain/projects";
import {
	fileChangesFromSessionItems,
	isTurnRunning,
	lastUserMessageText,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
} from "#/domain/session-item";
import {
	backgroundTurnPollChatIds,
	composerBusyForOpenChat,
	listedChatHarnessId,
	listedChatModelId,
	listedChatTurnStatus,
	SIDEBAR_PINNED_STORAGE_KEY,
	type SidebarChat,
	selectedChatIdAfterDelete,
	sessionViewAppliesToOpenChat,
	sidebarIsPinnedInStorage,
	sidebarPinnedStorageValue,
	withBusyChat,
	withChatTurnStatus,
	withoutBusyChat,
} from "#/domain/sidebar-chats";
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
	const [composerModelId, setComposerModelId] = useState(
		initialSession.listedModelId,
	);
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
	const [sidebarPinReady, setSidebarPinReady] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [toolsView, setToolsView] = useState<ToolsView>("diff");
	const [inspectorView, setInspectorView] = useState<InspectorView>("diff");
	const [customSplit, setCustomSplit] = useState<number | null>(null);
	const [splitting, setSplitting] = useState(false);
	const workspaceBody = useRef<HTMLDivElement>(null);
	const [sideChatOpen, setSideChatOpen] = useState(false);
	const [busyChatIds, setBusyChatIds] = useState<string[]>([]);
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
	const sessionEpoch = useRef(0);
	const loadedSessionId = useRef<string | undefined>(undefined);
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	const sessionViews = useRef(new Map<string, PublicCodexSession>());
	const bumpSessionEpoch = useCallback(() => {
		sessionEpoch.current += 1;
		return sessionEpoch.current;
	}, []);
	const rememberSessionView = useCallback(
		(next: PublicCodexSession) => {
			if (!next.agentSessionId) return;
			sessionViews.current.set(next.agentSessionId, next);
			if (!selectedProject?.id) return;
			const chatId = next.agentSessionId;
			queryClient.setQueryData(
				["agent-sessions", selectedProject.id],
				(current: readonly SidebarChat[] | undefined) =>
					withChatTurnStatus(current ?? [], chatId, next.turnStatus),
			);
		},
		[queryClient, selectedProject?.id],
	);
	const applySessionView = useCallback(
		(epoch: number, next: PublicCodexSession) => {
			rememberSessionView(next);
			if (epoch !== sessionEpoch.current) return;
			const openChatId = selectedSessionIdRef.current;
			if (
				openChatId &&
				next.agentSessionId &&
				!sessionViewAppliesToOpenChat({
					openChatId,
					agentSessionId: next.agentSessionId,
				})
			) {
				return;
			}
			setSession(next);
			if (next.agentSessionId) setSelectedSessionId(next.agentSessionId);
		},
		[rememberSessionView],
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
	selectedSessionIdRef.current = activeSessionId;
	const composerBusy = composerBusyForOpenChat({
		openChatId: activeSessionId,
		busyChatIds,
	});
	const listedTitle = sidebarChats.find(
		(chat) => chat.id === activeSessionId,
	)?.title;
	const followUpLayout = sessionUsesFollowUpLayout({
		items: session.items,
		turnStatus: session.turnStatus,
		listedTitle,
	});

	function sessionScope() {
		return {
			projectId: activeProjectId,
			harnessId,
			sessionId: activeSessionId,
		};
	}

	useEffect(() => {
		const mobile =
			compact ||
			window.matchMedia(
				"(max-width: 600px), (max-width: 900px) and (max-height: 500px)",
			).matches;
		if (mobile) {
			setProjectsOpen(false);
			setSidebarPinReady(true);
			return;
		}
		setProjectsOpen(
			sidebarIsPinnedInStorage(
				window.localStorage.getItem(SIDEBAR_PINNED_STORAGE_KEY),
			),
		);
		setSidebarPinReady(true);
	}, [compact]);

	useEffect(() => {
		if (!sidebarPinReady || compact) return;
		window.localStorage.setItem(
			SIDEBAR_PINNED_STORAGE_KEY,
			sidebarPinnedStorageValue(projectsOpen),
		);
	}, [compact, projectsOpen, sidebarPinReady]);

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
		autoResumeStarted.current = false;
		loadedSessionId.current = undefined;
		sessionViews.current.clear();
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
		if (!activeProjectId) return;
		const switching = loadedSessionId.current !== activeSessionId;
		if (!switching && composerBusy) return;
		loadedSessionId.current = activeSessionId;
		const epoch = sessionEpoch.current;
		void getCodexSession({
			data: {
				projectId: activeProjectId,
				harnessId,
				sessionId: activeSessionId,
			},
		}).then((next) => applySessionView(epoch, next));
	}, [
		applySessionView,
		composerBusy,
		harnessId,
		activeProjectId,
		activeSessionId,
	]);

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
		if (
			!shouldAutoResumeHarnessSession({
				harnessId,
				connection: session.connection,
			})
		) {
			return;
		}
		autoResumeStarted.current = true;
		setBusyChatIds((ids) => withBusyChat(ids, activeSessionId));
		const epoch = sessionEpoch.current;
		const chatId = activeSessionId;
		void connect({
			data: {
				projectId: activeProjectId,
				harnessId,
				sessionId: activeSessionId,
			},
		})
			.then((next) => applySessionView(epoch, next))
			.finally(() => setBusyChatIds((ids) => withoutBusyChat(ids, chatId)));
	}, [
		applySessionView,
		connect,
		harnessId,
		activeProjectId,
		activeSessionId,
		session.connection,
	]);

	useEffect(() => {
		const pollDeviceCode = session.connection.status === "awaiting_device_code";
		const pollTurn = runningAuthenticatedTurnShouldPoll({
			turnStatus: session.turnStatus,
			sideTurnStatus: session.sideTurnStatus,
			connectionStatus: session.connection.status,
			composerBusy,
		});
		if (!pollDeviceCode && !pollTurn) return;
		if (!activeProjectId) return;
		const epoch = sessionEpoch.current;
		const timer = window.setInterval(
			() => {
				void getCodexSession({
					data: {
						projectId: activeProjectId,
						harnessId,
						sessionId: activeSessionId,
					},
				}).then((next) => applySessionView(epoch, next));
			},
			pollTurn ? RUNNING_TURN_POLL_MS : 3000,
		);
		return () => window.clearInterval(timer);
	}, [
		activeProjectId,
		activeSessionId,
		applySessionView,
		composerBusy,
		harnessId,
		session.connection.status,
		session.sideTurnStatus,
		session.turnStatus,
	]);

	useEffect(() => {
		const ids = backgroundTurnPollChatIds({
			chats: sidebarChats,
			openChatId: activeSessionId,
			busyChatIds,
		});
		if (!activeProjectId || ids.length === 0) return;
		let inFlight = false;
		const pollSiblings = () => {
			if (inFlight) return;
			inFlight = true;
			void Promise.all(
				ids.map((sessionId) =>
					getCodexSession({
						data: {
							projectId: activeProjectId,
							harnessId: listedChatHarnessId(
								sidebarChats,
								sessionId,
								harnessId,
							),
							sessionId,
						},
					}).then((next) => {
						const wasRunning = listedChatTurnStatus(sidebarChats, sessionId);
						rememberSessionView(next);
						if (isTurnRunning(wasRunning) && !isTurnRunning(next.turnStatus)) {
							void chats.refetch();
						}
					}),
				),
			).finally(() => {
				inFlight = false;
			});
		};
		pollSiblings();
		const timer = window.setInterval(pollSiblings, RUNNING_TURN_POLL_MS);
		return () => window.clearInterval(timer);
	}, [
		activeProjectId,
		activeSessionId,
		busyChatIds,
		chats.refetch,
		harnessId,
		rememberSessionView,
		sidebarChats,
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
		const epoch = bumpSessionEpoch();
		void startSession({
			data: { projectId: selectedProject.id, harnessId },
		})
			.then((created) => {
				if (epoch !== sessionEpoch.current) return;
				setSelectedSessionId(created.id);
				autoResumeStarted.current = true;
				openedDiff.current = false;
				setDesktop({ status: "stopped" });
				setSession((current) => ({
					...current,
					agentSessionId: created.id,
					listedModelId: created.listedModelId || current.listedModelId,
					items: [],
					turnStatus: "idle",
					sideItems: [],
					sideTurnStatus: "idle",
					connection: { status: "disconnected" },
					canSend: false,
					canSendSide: false,
				}));
				if (created.listedModelId) setComposerModelId(created.listedModelId);
				void chats.refetch();
			})
			.catch((cause) => {
				if (epoch !== sessionEpoch.current) return;
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: harnessId,
						message: publicFailureMessage(cause),
					},
					canSend: false,
					canSendSide: false,
				}));
			});
	}

	function deleteChat(chatId: string) {
		if (!selectedProject) {
			return;
		}
		const remaining = sidebarChats.filter((chat) => chat.id !== chatId);
		queryClient.setQueryData(["agent-sessions", selectedProject.id], remaining);
		sessionViews.current.delete(chatId);
		const nextId = selectedChatIdAfterDelete({
			chats: sidebarChats,
			selectedChatId: activeSessionId,
			deletedChatId: chatId,
		});
		if (activeSessionId === chatId) {
			bumpSessionEpoch();
			setSelectedSessionId(nextId);
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
						message: publicFailureMessage(cause),
					},
					canSend: false,
					canSendSide: false,
				}));
			});
	}

	async function signOut() {
		await authClient.signOut();
		window.location.assign("/");
	}

	function sendSideChat(text: string) {
		const modelId =
			composerModelId || session.listedModelId || sessionModelId(session);
		const chatId = activeSessionId;
		setBusyChatIds((ids) => withBusyChat(ids, chatId));
		void sendTask({
			data: { ...sessionScope(), text, modelId, lane: "side" as const },
		})
			.then(setSession)
			.finally(() => {
				setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
				void chats.refetch();
			});
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
				busyChatIds={busyChatIds}
				openTurnStatus={session.turnStatus}
				openSideTurnStatus={session.sideTurnStatus}
				hasUserMessage={hasUserMessage}
				onSelectChat={(id) => {
					selectedSessionIdRef.current = id;
					bumpSessionEpoch();
					setSelectedSessionId(id);
					autoResumeStarted.current = false;
					openedDiff.current = false;
					setDesktop({ status: "stopped" });
					const cached = sessionViews.current.get(id);
					if (cached) {
						setSession(cached);
						if (cached.listedModelId) setComposerModelId(cached.listedModelId);
						return;
					}
					const listedTurn = listedChatTurnStatus(sidebarChats, id);
					const listedModelId = listedChatModelId(sidebarChats, id);
					if (listedModelId) setComposerModelId(listedModelId);
					setSession((current) => ({
						...current,
						agentSessionId: id,
						listedModelId: listedModelId || current.listedModelId,
						items: [],
						turnStatus: listedTurn,
						sideItems: [],
						sideTurnStatus: "idle",
						connection: { status: "disconnected" },
						canSend: false,
						canSendSide: false,
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
								key={session.agentSessionId ?? "new"}
								session={session}
								busy={composerBusy}
								listedTitle={listedTitle}
								harnessId={harnessId}
								onHarnessIdChange={(id) => {
									setHarnessId(id);
									if (id !== "opencode") return;
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void connect({
										data: { ...sessionScope(), harnessId: id },
									})
										.then(setSession)
										.finally(() =>
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId)),
										);
								}}
								apiKeyHints={apiKeyHints}
								onComposerModelIdChange={setComposerModelId}
								onConnect={() => {
									autoResumeStarted.current = true;
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void connect({
										data: sessionScope(),
									})
										.then(setSession)
										.finally(() =>
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId)),
										);
								}}
								onSaveApiKey={(id, apiKey) => {
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
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
										.finally(() =>
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId)),
										);
								}}
								onSend={(text, modelId) => {
									autoResumeStarted.current = true;
									const epoch = sessionEpoch.current;
									const scope = sessionScope();
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									if (activeProjectId) {
										queryClient.setQueryData(
											["agent-sessions", activeProjectId],
											withChatTurnStatus(sidebarChats, chatId, "running"),
										);
									}
									void (async () => {
										try {
											let current = session;
											if (current.connection.status !== "authenticated") {
												current = await connect({ data: scope });
												applySessionView(epoch, current);
												if (current.connection.status !== "authenticated") {
													return;
												}
											}
											const resolvedModel =
												modelId ||
												preferredSessionModelId(
													sessionModelsFromListed(current.models),
													{
														lastUsedId: current.listedModelId,
														excludedIds: current.blockedListedModelIds,
													},
												);
											if (!resolvedModel) return;
											const next = await sendTask({
												data: { ...scope, text, modelId: resolvedModel },
											});
											applySessionView(epoch, next);
										} catch (cause) {
											if (epoch !== sessionEpoch.current) return;
											setSession((current) => ({
												...current,
												connection: {
													status: "failed",
													provider: harnessId,
													message: publicFailureMessage(cause),
												},
											}));
										} finally {
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
											void chats.refetch();
										}
									})();
								}}
								onStop={() => {
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void stopTurn({
										data: sessionScope(),
									})
										.then(setSession)
										.finally(() => {
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
											void chats.refetch();
										});
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
									isolated
									busy={composerBusy}
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
	return (
		session.listedModelId ||
		preferredSessionModelId(sessionModelsFromListed(session.models), {
			lastUsedId: session.listedModelId,
			excludedIds: session.blockedListedModelIds,
		})
	);
}
