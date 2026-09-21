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
import { connectedProviderId } from "#/domain/agent-connection";
import {
	claudeSessionRemembersSignIn,
	rememberedClaudeModels,
} from "#/domain/claude-auth";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import {
	RUNNING_TURN_POLL_MS,
	harnessLoginIsPending,
	runningAuthenticatedTurnShouldPoll,
} from "#/domain/harness-access";
import {
	inspectorPaneIsWide,
	inspectorSplitFromPointer,
	inspectorSplitRatio,
	inspectorStaysBesideChat,
	nudgeInspectorSplit,
} from "#/domain/inspector-split";
import { publicFailureMessage } from "#/domain/project-workspace";
import { type Project, selectedProjectIdAfterDelete } from "#/domain/projects";
import {
	type ListedPullRequest,
	sidebarChatPrMarkForWorkspace,
} from "#/domain/sidebar-pr";
import {
	fileChangesFromSessionItems,
	isTurnRunning,
	lastUserMessageText,
	sessionItemsQueuedWithUser,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
	sessionViewShouldReplaceOpenTurn,
} from "#/domain/session-item";
import {
	backgroundTurnPollChatIds,
	composerBusyForOpenChat,
	composerHarnessForChat,
	listedChatHarnessId,
	listedChatModelId,
	rememberedClaudeModelIdFromChats,
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
import {
	desktopInspectorShouldStart,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { authClient } from "../auth/client";
import { requestJson } from "../projects/api";
import { deleteOwnedProject } from "../projects/project.fn";
import {
	deleteProjectAgentSession,
	listProjectAgentSessions,
	startProjectAgentSession,
} from "../sessions/agent-session.fn";
import {
	completeClaudeSessionAuth,
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
import { getWorkspaceDesktop, startWorkspaceDesktopFn } from "./desktop.fn";
import { ProjectSettings } from "./project-settings";
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
	const inspectorBeside = inspectorStaysBesideChat(compact);
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
	const pullRequests = useQuery({
		queryKey: [
			"github",
			"pull-requests",
			selectedProject?.installationId,
			selectedProject?.repositoryId,
		],
		queryFn: () =>
			requestJson<{ pullRequests: ListedPullRequest[] }>(
				`/api/github/pull-requests?installationId=${selectedProject?.installationId}&repositoryId=${selectedProject?.repositoryId}`,
			),
		enabled: Boolean(
			selectedProject?.installationId && selectedProject?.repositoryId,
		),
	});
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
	const deleteProject = useServerFn(deleteOwnedProject);
	const [projectsOpen, setProjectsOpen] = useState(false);
	const [sidebarPinReady, setSidebarPinReady] = useState(false);
	const [inspectorOpen, setInspectorOpen] = useState(false);
	const [toolsView, setToolsView] = useState<ToolsView>("files");
	const [inspectorView, setInspectorView] = useState<InspectorView>("files");
	const [selectedFilePath, setSelectedFilePath] = useState<string>();
	const [customSplit, setCustomSplit] = useState<number | null>(null);
	const [splitting, setSplitting] = useState(false);
	const workspaceBody = useRef<HTMLDivElement>(null);
	const [sideChatOpen, setSideChatOpen] = useState(false);
	const [busyChatIds, setBusyChatIds] = useState<string[]>([]);
	const [harnessId, setHarnessId] = useState<AgentProviderId>(
		DEFAULT_COMPOSER_HARNESS_ID,
	);
	const [desktop, setDesktop] = useState<WorkspaceDesktop>({
		status: "stopped",
	});
	const [desktopBusy, setDesktopBusy] = useState(false);
	const desktopStartInFlight = useRef(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [composerDraft, setComposerDraft] = useState(false);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const composerDraftRef = useRef(false);
	composerDraftRef.current = composerDraft;
	const sessionEpoch = useRef(0);
	const loadedSessionId = useRef<string | undefined>(undefined);
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	const pendingSendRef = useRef<{
		text: string;
		modelId: string;
		variant?: string;
		fast?: boolean;
	} | null>(null);
	const claudeLoginWindowRef = useRef<Window | null>(null);
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
			if (epoch !== sessionEpoch.current) return;
			if (composerDraftRef.current) return;
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
			setSession((current) => {
				if (
					!sessionViewShouldReplaceOpenTurn({
						currentStatus: current.turnStatus,
						nextStatus: next.turnStatus,
						currentItems: current.items,
						nextItems: next.items,
					})
				) {
					return current;
				}
				rememberSessionView(next);
				if (next.agentSessionId) setSelectedSessionId(next.agentSessionId);
				const provider = connectedProviderId(next.connection);
				const listed = next.agentSessionId
					? listedChatHarnessId(chats.data ?? [], next.agentSessionId, "")
					: "";
				if (provider && (!listed || listed === provider)) {
					setHarnessId(provider);
				}
				return next;
			});
		},
		[chats.data, rememberSessionView],
	);
	const connect = useServerFn(connectCodexSession);
	const completeClaudeAuth = useServerFn(completeClaudeSessionAuth);
	const sendTask = useServerFn(sendCodexSessionTask);
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const loadDesktop = useServerFn(getWorkspaceDesktop);
	const startDesktop = useServerFn(startWorkspaceDesktopFn);
	const fileChanges = fileChangesFromSessionItems(session.items);
	const openedDiff = useRef(false);
	const splitRatio = inspectorSplitRatio({
		custom: customSplit,
		wide: inspectorPaneIsWide(inspectorView),
	});
	const sessionTitle = sessionTitleFromItems(session.items);
	const hasUserMessage = Boolean(lastUserMessageText(session.items));
	const listedPullRequests = pullRequests.data?.pullRequests ?? [];
	const sidebarChats = (chats.data ?? []).map((chat) => {
		const mark = sidebarChatPrMarkForWorkspace({
			workspaceId: chat.workspaceId,
			pullRequests: listedPullRequests,
		});
		return {
			...chat,
			prUrl: mark?.url ?? null,
			prNeed: mark?.need ?? null,
		};
	});
	const activeProjectId = selectedProject?.id;
	const activeSessionId =
		selectedSessionId ?? session.agentSessionId ?? undefined;
	selectedSessionIdRef.current = activeSessionId;
	const requestDesktop = useCallback(() => {
		if (desktopStartInFlight.current) return;
		if (
			!desktopInspectorShouldStart({
				tabActive: true,
				projectId: selectedProject?.id,
				sessionId: activeSessionId,
				desktop,
				busy: desktopBusy,
			}) &&
			desktop.status !== "failed"
		) {
			return;
		}
		desktopStartInFlight.current = true;
		setDesktopBusy(true);
		setDesktop({ status: "starting" });
		void startDesktop({
			data: {
				projectId: selectedProject?.id,
				sessionId: activeSessionId,
			},
		})
			.then(setDesktop)
			.finally(() => {
				desktopStartInFlight.current = false;
				setDesktopBusy(false);
			});
	}, [
		activeSessionId,
		desktop,
		desktopBusy,
		selectedProject?.id,
		startDesktop,
	]);
	const composerBusy = composerBusyForOpenChat({
		openChatId: activeSessionId,
		busyChatIds,
	});
	const openTurnStatus = session.turnStatus;
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

	function rememberedClaudeId(forHarness: AgentProviderId = harnessId) {
		return (
			(forHarness === "claude" &&
			claudeSessionRemembersSignIn(session.listedModelId)
				? session.listedModelId
				: "") ||
			(forHarness === "claude"
				? listedChatModelId(sidebarChats, activeSessionId ?? "")
				: "") ||
			rememberedClaudeModelIdFromChats(sidebarChats)
		);
	}

	function applyRememberedClaude(id: AgentProviderId) {
		if (id !== "claude") return;
		const listed = rememberedClaudeId(id);
		if (!claudeSessionRemembersSignIn(listed)) return;
		setSession((current) => ({
			...current,
			connection: {
				status: "authenticated",
				provider: "claude",
				authMode: "subscription",
				planType: null,
				email: null,
			},
			models:
				current.models.length > 0
					? current.models
					: rememberedClaudeModels(listed),
			listedModelId: listed || current.listedModelId,
		}));
	}

	function revealClaudeLogin(url: string) {
		const popup = claudeLoginWindowRef.current;
		if (popup && !popup.closed) {
			popup.location.href = url;
			return;
		}
		window.open(url, "ytimesy-claude-login", "noopener,noreferrer");
	}

	function closeClaudeLoginWindow() {
		const popup = claudeLoginWindowRef.current;
		if (popup && !popup.closed) popup.close();
		claudeLoginWindowRef.current = null;
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
		const params = new URLSearchParams(window.location.search);
		if (params.get("addProject") !== "1") return;
		setComposerDraft(true);
		setProjectPickerOpen(true);
		params.delete("addProject");
		const query = params.toString();
		window.history.replaceState(
			{},
			"",
			`${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
		);
	}, []);

	useEffect(() => {
		void activeProjectId;
		setSelectedSessionId(undefined);
		loadedSessionId.current = undefined;
		sessionViews.current.clear();
		setSelectedFilePath(undefined);
	}, [activeProjectId]);

	useEffect(() => {
		if (composerDraft || selectedSessionId || !chats.data?.[0]) return;
		const first = chats.data[0];
		setSelectedSessionId(first.id);
		if (first.harnessId) setHarnessId(first.harnessId);
		if (first.listedModelId) {
			setSession((current) => ({
				...current,
				agentSessionId: first.id,
				listedModelId: first.listedModelId ?? current.listedModelId,
			}));
		}
	}, [chats.data, composerDraft, selectedSessionId]);

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
		if (!activeProjectId || composerDraft) return;
		const switching = loadedSessionId.current !== activeSessionId;
		if (!switching && composerBusy) return;
		loadedSessionId.current = activeSessionId;
		const epoch = sessionEpoch.current;
		void getCodexSession({
			data: {
				projectId: activeProjectId,
				harnessId: listedChatHarnessId(
					chats.data ?? [],
					activeSessionId ?? "",
					harnessId,
				),
				sessionId: activeSessionId,
			},
		}).then((next) => applySessionView(epoch, next));
	}, [
		applySessionView,
		chats.data,
		composerBusy,
		composerDraft,
		harnessId,
		activeProjectId,
		activeSessionId,
	]);

	useEffect(() => {
		if (compact || openedDiff.current || fileChanges.length === 0) return;
		openedDiff.current = true;
		setToolsView("files");
		setInspectorView("files");
		setInspectorOpen(true);
	}, [compact, fileChanges.length]);

	useEffect(() => {
		const pollDeviceCode = harnessLoginIsPending(session.connection);
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

	function openMentionedFile(path: string) {
		setSelectedFilePath(path);
		openInspector("files");
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

	function openAddProject() {
		setSettingsOpen(false);
		bumpSessionEpoch();
		selectedSessionIdRef.current = undefined;
		setSelectedSessionId(undefined);
		setSession((current) => ({
			...current,
			workspaceId: null,
			agentSessionId: null,
			items: [],
			turnStatus: "idle",
			sideItems: [],
			sideTurnStatus: "idle",
			canSend: false,
			canSendSide: false,
		}));
		setComposerDraft(true);
		setProjectPickerOpen(true);
		if (compact) setProjectsOpen(false);
	}

	function startNewChat(projectId?: string) {
		const targetProjectId = projectId ?? selectedProject?.id;
		if (!targetProjectId) {
			openAddProject();
			return;
		}
		if (projectId) setSelectedProjectId(projectId);
		setComposerDraft(false);
		setProjectPickerOpen(false);
		const epoch = bumpSessionEpoch();
		void startSession({
			data: { projectId: targetProjectId, harnessId },
		})
			.then((created) => {
				if (epoch !== sessionEpoch.current) return;
				setSelectedSessionId(created.id);
				openedDiff.current = false;
				setSelectedFilePath(undefined);
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
			openedDiff.current = false;
			setSelectedFilePath(undefined);
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

	function removeProject(projectId: string) {
		const listed = projects.data ?? [];
		const remaining = listed.filter((project) => project.id !== projectId);
		const nextId = selectedProjectIdAfterDelete({
			projects: listed,
			selectedProjectId: selectedProject?.id,
			deletedProjectId: projectId,
		});
		queryClient.setQueryData(["projects"], remaining);
		queryClient.removeQueries({ queryKey: ["agent-sessions", projectId] });
		setSelectedProjectId(nextId);
		if (selectedProject?.id === projectId) {
			bumpSessionEpoch();
			selectedSessionIdRef.current = undefined;
			setSelectedSessionId(undefined);
			openedDiff.current = false;
			setSelectedFilePath(undefined);
			setDesktop({ status: "stopped" });
			setComposerDraft(!nextId);
			setProjectPickerOpen(false);
			setSession((current) => ({
				...current,
				workspaceId: null,
				agentSessionId: null,
				items: [],
				turnStatus: "idle",
				sideItems: [],
				sideTurnStatus: "idle",
				connection: { status: "disconnected" },
				canSend: false,
				canSendSide: false,
			}));
		}
		void deleteProject({ data: { projectId } })
			.then(() => projects.refetch())
			.catch((cause) => {
				void projects.refetch();
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
		const epoch = sessionEpoch.current;
		setBusyChatIds((ids) => withBusyChat(ids, chatId));
		void sendTask({
			data: { ...sessionScope(), text, modelId, lane: "side" as const },
		})
			.then((next) => applySessionView(epoch, next))
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
				onAddProject={openAddProject}
				chats={sidebarChats}
				selectedChatId={activeSessionId}
				busyChatIds={busyChatIds}
				openTurnStatus={openTurnStatus}
				openSideTurnStatus={session.sideTurnStatus}
				hasUserMessage={hasUserMessage}
				onSelectChat={(id) => {
					setComposerDraft(false);
					setProjectPickerOpen(false);
					selectedSessionIdRef.current = id;
					bumpSessionEpoch();
					setSelectedSessionId(id);
					openedDiff.current = false;
					setSelectedFilePath(undefined);
					setDesktop({ status: "stopped" });
					const cached = sessionViews.current.get(id);
					setHarnessId(
						composerHarnessForChat({
							listedHarnessId: sidebarChats.find((chat) => chat.id === id)
								?.harnessId,
							connectionProvider: cached
								? connectedProviderId(cached.connection)
								: null,
							fallback: harnessId,
						}),
					);
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
				onDeleteProject={removeProject}
				onOpenSettings={() => setSettingsOpen(true)}
			/>
			<ProjectSettings
				open={settingsOpen}
				projectId={selectedProject?.id}
				projects={projects.data ?? []}
				selectedProject={selectedProject}
				onProjectAdded={(project) => {
					setSelectedProjectId(project.id);
					void projects.refetch();
				}}
				onSignOut={() => {
					void signOut();
				}}
				onClose={() => setSettingsOpen(false)}
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
								<button
									type="button"
									className="panel-toggle session-title-chats"
									aria-label="Open chats"
									title="Open chats"
									aria-expanded={projectsOpen}
									aria-controls="project-sidebar"
									onClick={() => setProjectsOpen(true)}
								>
									<img
										className="brand-mark"
										src="/brand/mark.svg"
										width={22}
										height={22}
										alt=""
									/>
								</button>
								<div className="session-title-copy">
									<span className="session-title">{sessionTitle}</span>
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
								<button
									type="button"
									className="panel-toggle session-title-chats"
									aria-label="Open chats"
									title="Open chats"
									aria-expanded={projectsOpen}
									aria-controls="project-sidebar"
									onClick={() => setProjectsOpen(true)}
								>
									<img
										className="brand-mark"
										src="/brand/mark.svg"
										width={22}
										height={22}
										alt=""
									/>
								</button>
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
								listedTitle={composerDraft ? undefined : listedTitle}
								harnessId={harnessId}
								onHarnessIdChange={(id) => {
									setHarnessId(id);
									applyRememberedClaude(id);
								}}
								onComposerModelIdChange={setComposerModelId}
								onConnect={() => {
									const epoch = sessionEpoch.current;
									const scope = sessionScope();
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void connect({ data: scope })
										.then((next) => applySessionView(epoch, next))
										.catch((cause) => {
											if (epoch !== sessionEpoch.current) return;
											setSession((current) => ({
												...current,
												connection: {
													status: "failed",
													provider: harnessId,
													message: publicFailureMessage(cause),
												},
											}));
										})
										.finally(() => {
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
										});
								}}
								onSubmitAuthCode={(code) => {
									const epoch = sessionEpoch.current;
									const scope = sessionScope();
									const chatId = activeSessionId;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void completeClaudeAuth({
										data: { ...scope, code },
									})
										.then(async (next) => {
											applySessionView(epoch, next);
											const pending = pendingSendRef.current;
											if (
												next.connection.status !== "authenticated" ||
												!pending
											) {
												return;
											}
											pendingSendRef.current = null;
											closeClaudeLoginWindow();
											const resolvedModel =
												pending.modelId ||
												preferredSessionModelId(
													sessionModelsFromListed(next.models),
													{
														lastUsedId: next.listedModelId,
														excludedIds: next.blockedListedModelIds,
													},
												);
											if (!resolvedModel) return;
											const sent = await sendTask({
												data: {
													...scope,
													text: pending.text,
													modelId: resolvedModel,
													...(pending.variant
														? { variant: pending.variant }
														: {}),
													...(pending.fast ? { fast: true } : {}),
												},
											});
											applySessionView(epoch, sent);
										})
										.catch((cause) => {
											if (epoch !== sessionEpoch.current) return;
											setSession((current) => ({
												...current,
												connection: {
													status: "failed",
													provider: "claude",
													message: publicFailureMessage(cause),
												},
											}));
										})
										.finally(() => {
											setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
											void chats.refetch();
										});
								}}
								onSend={(text, modelId, options) => {
									const epoch = sessionEpoch.current;
									const scope = sessionScope();
									const chatId = activeSessionId;
									pendingSendRef.current = {
										text,
										modelId,
										...(options?.reasoningId
											? { variant: options.reasoningId }
											: {}),
										...(options?.fast ? { fast: true } : {}),
									};
									if (
										harnessId === "claude" &&
										session.connection.status !== "authenticated"
									) {
										claudeLoginWindowRef.current = window.open(
											"about:blank",
											"ytimesy-claude-login",
										);
									}
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									setSession((current) => ({
										...current,
										turnStatus: "running",
										items: sessionItemsQueuedWithUser(current.items, text),
									}));
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
												if (
													current.connection.status ===
														"awaiting_device_code" &&
													current.connection.verificationUrl
												) {
													revealClaudeLogin(
														current.connection.verificationUrl,
													);
													return;
												}
												if (current.connection.status !== "authenticated") {
													pendingSendRef.current = null;
													closeClaudeLoginWindow();
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
											if (!resolvedModel) {
												pendingSendRef.current = null;
												closeClaudeLoginWindow();
												return;
											}
											const pending = pendingSendRef.current;
											const next = await sendTask({
												data: {
													...scope,
													text,
													modelId: resolvedModel,
													...(pending?.variant
														? { variant: pending.variant }
														: {}),
													...(pending?.fast ? { fast: true } : {}),
												},
											});
											applySessionView(epoch, next);
											if (
												next.connection.status === "awaiting_device_code" &&
												next.connection.verificationUrl
											) {
												revealClaudeLogin(next.connection.verificationUrl);
												return;
											}
											pendingSendRef.current = null;
											closeClaudeLoginWindow();
										} catch (cause) {
											pendingSendRef.current = null;
											closeClaudeLoginWindow();
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
									const epoch = sessionEpoch.current;
									setBusyChatIds((ids) => withBusyChat(ids, chatId));
									void stopTurn({
										data: sessionScope(),
									})
										.then((next) => applySessionView(epoch, next))
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
								onOpenFile={openMentionedFile}
								projects={projects.data ?? []}
								selectedProject={selectedProject}
								onSelectProject={(id) => {
									setSelectedProjectId(id);
									setProjectPickerOpen(false);
								}}
								projectPickerOpen={projectPickerOpen}
								onProjectPickerOpenChange={setProjectPickerOpen}
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
									<button
										type="button"
										className="setup-back"
										onClick={openAddProject}
									>
										Add your first project
									</button>
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
							selectedFilePath={selectedFilePath}
							onSelectFilePath={setSelectedFilePath}
							desktop={desktop}
							desktopBusy={desktopBusy}
							projectId={selectedProject?.id}
							sessionId={activeSessionId}
							onStartDesktop={requestDesktop}
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
									onStop={() => {
										const chatId = activeSessionId;
										const epoch = sessionEpoch.current;
										setBusyChatIds((ids) => withBusyChat(ids, chatId));
										void stopTurn({
											data: { ...sessionScope(), lane: "side" as const },
										})
											.then((next) => applySessionView(epoch, next))
											.finally(() => {
												setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
												void chats.refetch();
											});
									}}
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
