import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Maximize2, Minimize2, PanelRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { connectedProviderId } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
	offeredAgentProviderId,
} from "#/domain/agent-provider";
import { shouldPollAgentTasks } from "#/domain/agent-task";
import {
	claudeSessionRemembersSignIn,
	rememberedClaudeModels,
} from "#/domain/claude-auth";
import {
	harnessLoginIsPending,
	RUNNING_TURN_POLL_MS,
	runningTurnShouldPoll,
} from "#/domain/harness-access";
import {
	inspectorPaneIsWide,
	inspectorSplitRatio,
	workspaceNeedsSinglePane,
} from "#/domain/inspector-split";
import { publicFailureMessage } from "#/domain/project-workspace";
import { type Project, selectedProjectIdAfterDelete } from "#/domain/projects";
import { workspacePublicationBranch } from "#/domain/publication";
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
	type LiveProgressMarks,
	progressIsFresh,
	progressMatchesTurn,
	type SessionProgress,
} from "#/domain/session-progress";
import {
	backgroundTurnPollChatIds,
	composerBusyForOpenChat,
	composerHarnessForChat,
	listedChatHarnessId,
	listedChatModelId,
	listedChatTurnStatus,
	rememberedClaudeModelIdFromChats,
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
	type ListedPullRequest,
	sidebarChatPrMarkForWorkspace,
} from "#/domain/sidebar-pr";
import {
	agentDesktopActivityInTurn,
	desktopInspectorShouldStart,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import type { SettingsSection } from "#/domain/workspace-settings";
import { captureAnalytics } from "#/features/analytics/client";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { authClient } from "../auth/client";
import { requestJson, retryTransientRead } from "../projects/api";
import { deleteOwnedProject } from "../projects/project.fn";
import {
	getAgentCompetitions,
	startAgentCompetition,
	stopAgentCompetition,
} from "../sessions/agent-competition.fn";
import {
	deleteProjectAgentSession,
	listProjectAgentSessions,
	listProjectAgentTasks,
	startProjectAgentSession,
} from "../sessions/agent-session.fn";
import {
	connectCodexSession,
	getCodexSession,
	pollCodexLogin,
	sendCodexSessionTask,
	stopCodexSessionTurn,
} from "../sessions/codex-session.fn";
import {
	mcpSignInResult,
	takeMcpSignInReturn,
} from "../sessions/mcp-sign-in-return";
import {
	preferredSessionModelId,
	sessionModelsFromListed,
} from "../sessions/model-capabilities";
import { SessionLauncher } from "../sessions/session-launcher";
import { sessionReconciliationQuery } from "../sessions/session-reconciliation";
import { getWorkspaceDesktop, startWorkspaceDesktopFn } from "./desktop.fn";
import { readWorkspaceChangesFn } from "./explorer.fn";
import { ProjectSettings } from "./project-settings";
import { ProjectSidebar } from "./project-sidebar";
import { useCompactLayout } from "./use-compact-layout";
import {
	type InspectorView,
	type ToolsView,
	WorkspaceInspector,
} from "./workspace-inspector";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspacePanes } from "./workspace-panes";

export function WorkspaceHome({
	initialSession,
	initialProjects,
}: {
	initialSession: PublicCodexSession;
	initialProjects?: Project[];
}) {
	const compact = useCompactLayout();
	const workspaceMainRef = useRef<HTMLElement>(null);
	const [inspectorCompact, setInspectorCompact] = useState(false);
	const [inspectorExpanded, setInspectorExpanded] = useState(false);
	useEffect(() => {
		const main = workspaceMainRef.current;
		if (!main) return;
		const observer = new ResizeObserver(([entry]) => {
			if (entry)
				setInspectorCompact(workspaceNeedsSinglePane(entry.contentRect.width));
		});
		observer.observe(main);
		return () => observer.disconnect();
	}, []);
	const singlePane = compact || inspectorCompact || inspectorExpanded;
	const queryClient = useQueryClient();
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: () => requestJson<Project[]>("/api/projects"),
		initialData: initialProjects,
		retry: retryTransientRead,
		retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
	});
	const [selectedProjectId, setSelectedProjectId] = useState<string>();
	const selectedProject =
		projects.data?.find((project) => project.id === selectedProjectId) ??
		projects.data?.[0];
	const [selectedSessionId, setSelectedSessionId] = useState<string>();
	const [session, setSession] = useState(initialSession);
	const [recoveryDraft, setRecoveryDraft] = useState<{
		id: string;
		prompt: string;
	} | null>(null);
	const currentSessionRef = useRef(session);
	currentSessionRef.current = session;
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
	const [inspectorView, setInspectorView] = useState<InspectorView>("overview");
	const [selectedFilePath, setSelectedFilePath] = useState<string>();
	const [customSplit, setCustomSplit] = useState<number | null>(null);
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
	const [settingsSection, setSettingsSection] = useState<SettingsSection>();
	// Back from an MCP provider's sign-in page: reopen the panel that started it.
	useEffect(() => {
		const result = mcpSignInResult(window.location.search);
		if (!result) return;
		const back = takeMcpSignInReturn();
		const here = new URL(window.location.href);
		here.searchParams.delete("mcpSignIn");
		window.history.replaceState(
			window.history.state,
			"",
			`${here.pathname}${here.search}${here.hash}`,
		);
		setSettingsSection(back?.section ?? "plugins");
		setSettingsOpen(true);
		void queryClient.invalidateQueries({ queryKey: ["mcp-servers"] });
		void queryClient.invalidateQueries({ queryKey: ["plugins"] });
		if (result === "ok") toast.success("Signed in.");
		else if (result === "cancelled") toast("Sign-in was cancelled.");
		else toast.error("Sign-in didn't complete. Try again.");
	}, [queryClient]);
	const [composerDraft, setComposerDraft] = useState(false);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const composerDraftRef = useRef(false);
	composerDraftRef.current = composerDraft;
	/** Set from a draft send until its new chat's first view arrives. */
	const pendingNewChatRef = useRef(false);
	const sessionEpoch = useRef(0);
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	const pendingSendRef = useRef<{
		text: string;
		modelId: string;
		variant?: string;
		fast?: boolean;
		mode?: "plan";
	} | null>(null);
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
	const liveProgress = useRef<LiveProgressMarks | null>({});
	const applySessionView = useCallback(
		(epoch: number, next: PublicCodexSession) => {
			if (epoch !== sessionEpoch.current) return;
			if (composerDraftRef.current) return;
			if (pendingNewChatRef.current && next.agentSessionId) {
				// The draft send's new chat: adopt it before the open-chat check.
				pendingNewChatRef.current = false;
				selectedSessionIdRef.current = next.agentSessionId;
			}
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
				const fresh = (lane: "main" | "side") =>
					progressIsFresh(
						liveProgress.current,
						lane,
						next.agentSessionId,
						Date.now(),
					);
				next = {
					...next,
					...(next.turnStatus === "running" && fresh("main")
						? { items: current.items }
						: {}),
					...(next.sideTurnStatus === "running" && fresh("side")
						? { sideItems: current.sideItems }
						: {}),
				};
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
					? (chats.data ?? []).find((chat) => chat.id === next.agentSessionId)
							?.harnessId
					: undefined;
				if (provider && (!listed || listed === provider)) {
					setHarnessId(provider);
				}
				return next;
			});
		},
		[chats.data, rememberSessionView],
	);
	const connect = useServerFn(connectCodexSession);
	const applySessionViewRef = useRef(applySessionView);
	applySessionViewRef.current = applySessionView;
	const sendTask = useServerFn(sendCodexSessionTask);
	const startCompetition = useServerFn(startAgentCompetition);
	const stopCompetition = useServerFn(stopAgentCompetition);
	const loadCompetition = useServerFn(getAgentCompetitions);
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const loadDesktop = useServerFn(getWorkspaceDesktop);
	const startDesktop = useServerFn(startWorkspaceDesktopFn);
	const readChanges = useServerFn(readWorkspaceChangesFn);
	// Git in the workspace is the source of truth for what changed; the
	// transcript only fills in while the machine is asleep.
	const gitChanges = useQuery({
		queryKey: ["workspace-changes", selectedProject?.id, selectedSessionId],
		queryFn: () =>
			readChanges({
				data: { projectId: selectedProject?.id, sessionId: selectedSessionId },
			}),
		enabled: Boolean(selectedProject?.id && selectedSessionId),
		refetchInterval: session.turnStatus === "running" ? 10_000 : 60_000,
		staleTime: 5_000,
	});
	const refetchChanges = gitChanges.refetch;
	useEffect(() => {
		// A finished turn is when the agent's edits settle; show them right away.
		if (session.turnStatus !== "running") void refetchChanges();
	}, [session.turnStatus, refetchChanges]);
	const fileChanges =
		gitChanges.data ?? fileChangesFromSessionItems(session.items);
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
			workingBranch: chat.workingBranch,
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
	const agentTasks = useQuery({
		queryKey: ["agent-tasks", activeProjectId, activeSessionId],
		queryFn: () =>
			listProjectAgentTasks({
				data: {
					projectId: activeProjectId,
					rootSessionId: activeSessionId,
				},
			}),
		enabled: Boolean(activeProjectId && activeSessionId),
		refetchInterval: (query) =>
			shouldPollAgentTasks(session.turnStatus, query.state.data ?? [])
				? 2_500
				: false,
	});
	const competition = useQuery({
		queryKey: ["agent-competition", activeSessionId],
		queryFn: () =>
			loadCompetition({ data: { rootSessionId: activeSessionId } }),
		enabled: Boolean(activeSessionId),
		refetchInterval: (query) =>
			query.state.data?.some((group) =>
				["queued", "working", "judging"].includes(group.status),
			)
				? 2_500
				: false,
	});
	const activeCompetition = competition.data?.find((group) =>
		["queued", "working", "judging"].includes(group.status),
	);
	useEffect(() => {
		if (
			activeSessionId &&
			(session.turnStatus === "completed" || session.turnStatus === "failed")
		) {
			void agentTasks.refetch();
			void pullRequests.refetch();
			void chats.refetch();
		}
	}, [
		activeSessionId,
		session.turnStatus,
		agentTasks.refetch,
		pullRequests.refetch,
		chats.refetch,
	]);
	const taskHandoffs = (agentTasks.data ?? [])
		.filter((task) => task.pullRequestUrl)
		.map((task) => `${task.id}:${task.pullRequestUrl}:${task.status}`)
		.join("|");
	useEffect(() => {
		if (taskHandoffs) void pullRequests.refetch();
	}, [taskHandoffs, pullRequests.refetch]);
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
		sessionViews.current.clear();
		setSelectedFilePath(undefined);
	}, [activeProjectId]);

	useEffect(() => {
		if (
			composerDraft ||
			selectedSessionId ||
			pendingNewChatRef.current ||
			!chats.data?.[0]
		)
			return;
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

	// The agent starts the desktop itself for visual QA; show it working.
	const agentDesktopActivity = agentDesktopActivityInTurn({
		turnStatus: session.turnStatus,
		items: session.items,
	});
	const followedAgentDesktop = useRef<string | null>(null);
	const inspectorOpenRef = useRef(inspectorOpen);
	inspectorOpenRef.current = inspectorOpen;
	const followedSessionId = useRef(activeSessionId);
	followedSessionId.current = activeSessionId;
	useEffect(() => {
		if (
			!agentDesktopActivity ||
			!activeProjectId ||
			followedAgentDesktop.current === agentDesktopActivity
		)
			return;
		followedAgentDesktop.current = agentDesktopActivity;
		if (!inspectorOpenRef.current) {
			setInspectorView("desktop");
			setInspectorOpen(true);
		}
		let attempts = 0;
		const refresh = () =>
			void loadDesktop({
				data: { projectId: activeProjectId, sessionId: activeSessionId },
			}).then((next) => {
				if (followedSessionId.current !== activeSessionId) return;
				if (next.status === "running") setDesktop(next);
				// The desktop may still be starting when the first tool call shows.
				else if (++attempts < 12) window.setTimeout(refresh, 5_000);
			});
		refresh();
	}, [agentDesktopActivity, activeProjectId, activeSessionId, loadDesktop]);

	const pollSession =
		harnessLoginIsPending(session.connection) ||
		runningTurnShouldPoll({
			turnStatus: session.turnStatus,
			sideTurnStatus: session.sideTurnStatus,
			connectionStatus: session.connection.status,
			composerBusy,
		});
	const sessionRead = useQuery({
		...sessionReconciliationQuery(
			{
				projectId: activeProjectId ?? "",
				sessionId: activeSessionId ?? "",
				harnessId: listedChatHarnessId(
					chats.data ?? [],
					activeSessionId ?? "",
					harnessId,
				),
			},
			sessionEpoch.current,
		),
		enabled: Boolean(
			activeProjectId && activeSessionId && !composerDraft && !composerBusy,
		),
		refetchInterval: pollSession ? RUNNING_TURN_POLL_MS : false,
		refetchIntervalInBackground: true,
	});
	useEffect(() => {
		if (sessionRead.data)
			applySessionViewRef.current(
				sessionRead.data.epoch,
				sessionRead.data.view,
			);
	}, [sessionRead.data]);

	// A ChatGPT sign-in is per user, not per chat: poll it even from a new-chat
	// draft, then load the now-connected models and send state.
	const pollLogin = useServerFn(pollCodexLogin);
	const codexLogin = useQuery({
		queryKey: ["codex-device-login"],
		queryFn: () => pollLogin(),
		enabled:
			session.connection.status === "awaiting_device_code" &&
			session.connection.provider === "codex",
		refetchInterval: 3_000,
		refetchIntervalInBackground: true,
		gcTime: 0,
	});
	useEffect(() => {
		const login = codexLogin.data;
		if (!login || login.status === "pending") return;
		setSession((current) =>
			current.connection.status !== "awaiting_device_code"
				? current
				: {
						...current,
						connection:
							login.status === "failed"
								? {
										status: "failed",
										provider: "codex",
										message: login.message,
									}
								: login.status === "connected"
									? {
											status: "authenticated",
											provider: "codex",
											authMode: "chatgpt",
											planType: null,
											email: null,
										}
									: { status: "disconnected" },
					},
		);
		if (login.status !== "connected") return;
		void queryClient.invalidateQueries({ queryKey: ["agent-model-catalog"] });
		void getCodexSession({
			data: {
				projectId: activeProjectId ?? undefined,
				sessionId: activeSessionId ?? undefined,
				harnessId: "codex",
			},
		})
			.then((next) =>
				setSession((current) => ({
					...current,
					connection: next.connection,
					models: next.models,
					canSend: next.canSend,
				})),
			)
			.catch(() => undefined);
	}, [codexLogin.data, activeProjectId, activeSessionId, queryClient]);

	useEffect(() => {
		if (
			!activeProjectId ||
			!activeSessionId ||
			(session.turnStatus !== "running" && session.sideTurnStatus !== "running")
		)
			return;
		const epoch = sessionEpoch.current;
		const sources = (["main", "side"] as const).flatMap((lane) => {
			if (
				(lane === "main" ? session.turnStatus : session.sideTurnStatus) !==
				"running"
			)
				return [];
			const source = new EventSource(
				`/api/agent/progress?${new URLSearchParams({ projectId: activeProjectId, sessionId: activeSessionId, lane })}`,
			);
			let lastRevision = "";
			source.addEventListener("progress", (event: MessageEvent) => {
				if (
					epoch !== sessionEpoch.current ||
					selectedSessionIdRef.current !== activeSessionId
				)
					return;
				if (event.lastEventId && event.lastEventId === lastRevision) return;
				let progress: SessionProgress;
				try {
					progress = JSON.parse(event.data);
				} catch {
					return;
				}
				if (
					progress.sessionId !== activeSessionId ||
					!Array.isArray(progress.items)
				)
					return;
				if (
					!progressMatchesTurn(
						lane === "main"
							? currentSessionRef.current.items
							: currentSessionRef.current.sideItems,
						progress.items,
					)
				)
					return;
				lastRevision = event.lastEventId;
				liveProgress.current ??= {};
				liveProgress.current[lane] = {
					sessionId: activeSessionId,
					receivedAt: Date.now(),
				};
				setSession((current) => {
					if (
						!progressMatchesTurn(
							lane === "main" ? current.items : current.sideItems,
							progress.items,
						)
					)
						return current;
					if (lane === "side")
						return {
							...current,
							sideItems: progress.items,
							sideTurnStatus: progress.turnStatus,
						};
					return {
						...current,
						items: progress.items,
						turnStatus: progress.turnStatus,
						usage: progress.usage ?? current.usage,
					};
				});
				if (
					progress.turnStatus === "completed" ||
					progress.turnStatus === "failed"
				) {
					void getCodexSession({
						data: {
							projectId: activeProjectId,
							sessionId: activeSessionId,
							harnessId,
						},
					})
						.then((next) => applySessionViewRef.current(epoch, next))
						.catch(() => undefined);
				}
			});
			source.onerror = () => {
				if (liveProgress.current) delete liveProgress.current[lane];
			};
			return [source];
		});
		return () => {
			for (const source of sources) source.close();
			liveProgress.current = {};
		};
	}, [
		activeProjectId,
		activeSessionId,
		session.turnStatus,
		session.sideTurnStatus,
		harnessId,
	]);

	const backgroundIds = backgroundTurnPollChatIds({
		chats: sidebarChats,
		openChatId: activeSessionId,
		busyChatIds,
	});
	const backgroundReads = useQueries({
		queries: backgroundIds.map((sessionId) => ({
			...sessionReconciliationQuery(
				{
					projectId: activeProjectId ?? "",
					sessionId,
					harnessId: listedChatHarnessId(sidebarChats, sessionId, harnessId),
				},
				0,
			),
			enabled: Boolean(activeProjectId),
			refetchInterval: RUNNING_TURN_POLL_MS,
			refetchIntervalInBackground: true,
		})),
	});
	const appliedBackgroundReads = useRef(new WeakSet<object>());
	useEffect(() => {
		for (const result of backgroundReads) {
			if (!result.data || appliedBackgroundReads.current.has(result.data))
				continue;
			appliedBackgroundReads.current.add(result.data);
			const next = result.data.view;
			const wasRunning = listedChatTurnStatus(
				sidebarChats,
				next.agentSessionId ?? "",
			);
			rememberSessionView(next);
			if (isTurnRunning(wasRunning) && !isTurnRunning(next.turnStatus))
				void chats.refetch();
		}
	}, [backgroundReads, sidebarChats, rememberSessionView, chats.refetch]);

	function openInspector(view: ToolsView) {
		if (
			view === "files" ||
			view === "diff" ||
			view === "terminal" ||
			view === "desktop"
		)
			captureAnalytics("inspector_opened", { panel: view });
		setInspectorView(view);
		setInspectorOpen(true);
	}

	function openMentionedFile(path: string) {
		setSelectedFilePath(path);
		openInspector("files");
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
			selectedBranch: undefined,
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
		const newChatHarnessId = offeredAgentProviderId(harnessId);
		setHarnessId(newChatHarnessId);
		setComposerDraft(false);
		setProjectPickerOpen(false);
		const epoch = bumpSessionEpoch();
		setSession((current) => ({
			...current,
			agentSessionId: null,
			selectedBranch: undefined,
			listedModelId: "",
			models: [],
			items: [],
			turnStatus: "idle",
			sideItems: [],
			sideTurnStatus: "idle",
			connection: { status: "disconnected" },
			canSend: false,
			canSendSide: false,
		}));
		void startSession({
			data: { projectId: targetProjectId, harnessId: newChatHarnessId },
		})
			.then((created) => {
				if (epoch !== sessionEpoch.current) return;
				setSelectedSessionId(created.id);
				setInspectorView("overview");
				setSelectedFilePath(undefined);
				setDesktop({ status: "stopped" });
				setSession((current) => ({
					...current,
					agentSessionId: created.id,
					selectedBranch: undefined,
					listedModelId: created.listedModelId || current.listedModelId,
					items: [],
					turnStatus: "idle",
					sideItems: [],
					sideTurnStatus: "idle",
					connection: { status: "disconnected" },
					canSend: false,
					canSendSide: false,
				}));
				void chats.refetch();
			})
			.catch((cause) => {
				if (epoch !== sessionEpoch.current) return;
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: newChatHarnessId,
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
			setInspectorView("overview");
			setSelectedFilePath(undefined);
			setDesktop({ status: "stopped" });
			setSession((current) => ({
				...current,
				agentSessionId: nextId ?? null,
				selectedBranch: undefined,
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
			setInspectorView("overview");
			setSelectedFilePath(undefined);
			setDesktop({ status: "stopped" });
			setComposerDraft(!nextId);
			setProjectPickerOpen(false);
			setSession((current) => ({
				...current,
				workspaceId: null,
				agentSessionId: null,
				selectedBranch: undefined,
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

	function openChat(id: string) {
		setComposerDraft(false);
		setProjectPickerOpen(false);
		selectedSessionIdRef.current = id;
		bumpSessionEpoch();
		setSelectedSessionId(id);
		setInspectorView("overview");
		setSelectedFilePath(undefined);
		setDesktop({ status: "stopped" });
		const cached = sessionViews.current.get(id);
		setHarnessId(
			composerHarnessForChat({
				listedHarnessId: sidebarChats.find((chat) => chat.id === id)?.harnessId,
				connectionProvider: cached
					? connectedProviderId(cached.connection)
					: null,
				fallback: harnessId,
			}),
		);
		if (cached) {
			setSession(cached);
			return;
		}
		const listedTurn = listedChatTurnStatus(sidebarChats, id);
		const listedModelId = listedChatModelId(sidebarChats, id);
		setSession((current) => ({
			...current,
			agentSessionId: id,
			selectedBranch: undefined,
			listedModelId: listedModelId || current.listedModelId,
			items: [],
			turnStatus: listedTurn,
			sideItems: [],
			sideTurnStatus: "idle",
			connection: { status: "disconnected" },
			canSend: false,
			canSendSide: false,
		}));
	}

	const activeChat = sidebarChats.find((chat) => chat.id === activeSessionId);
	const activeHead =
		activeChat?.workingBranch ||
		(activeChat?.workspaceId
			? workspacePublicationBranch(activeChat.workspaceId)
			: null);
	const sessionPullRequests = listedPullRequests.filter(
		(pr) => Boolean(activeHead) && pr.head === activeHead,
	);
	const sessionPullRequest = sessionPullRequests[0];
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
				onSelectChat={openChat}
				onNewChat={startNewChat}
				onDeleteChat={deleteChat}
				onDeleteProject={removeProject}
				onOpenSettings={() => {
					setSettingsSection(undefined);
					setSettingsOpen(true);
				}}
			/>
			<ProjectSettings
				codexUsage={session.usage}
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
				initialSection={settingsSection}
			/>
			<main
				ref={workspaceMainRef}
				className="workspace-main"
				inert={compact && projectsOpen}
				data-can-expand-inspector={
					inspectorOpen && !compact && !inspectorCompact
				}
			>
				{inspectorOpen && !compact && !inspectorCompact ? (
					<button
						type="button"
						className="workspace-sidebar-toggle workspace-inspector-expand"
						aria-label={
							inspectorExpanded ? "Restore split view" : "Expand workspace"
						}
						title={
							inspectorExpanded ? "Restore split view" : "Expand workspace"
						}
						onClick={() => setInspectorExpanded((value) => !value)}
					>
						{inspectorExpanded ? (
							<Minimize2 size={16} />
						) : (
							<Maximize2 size={16} />
						)}
					</button>
				) : null}
				<button
					type="button"
					className="workspace-sidebar-toggle workspace-inspector-toggle"
					aria-label={
						inspectorOpen ? "Close right sidebar" : "Open right sidebar"
					}
					title={inspectorOpen ? "Close right sidebar" : "Open right sidebar"}
					aria-expanded={inspectorOpen}
					aria-controls="workspace-inspector"
					onClick={() => setInspectorOpen((open) => !open)}
				>
					<PanelRight size={18} />
				</button>
				<WorkspacePanes
					open={inspectorOpen}
					compact={singlePane}
					ratio={splitRatio}
					view={inspectorView}
					layout={followUpLayout ? "chat" : "empty"}
					onResize={setCustomSplit}
					onReset={() => setCustomSplit(null)}
				>
					<section
						className="welcome-panel"
						aria-label="Get started"
						data-layout={followUpLayout ? "chat" : "empty"}
						inert={singlePane && inspectorOpen}
						aria-hidden={singlePane && inspectorOpen}
					>
						{followUpLayout ? (
							<div className="session-title-row">
								<div className="session-title-copy">
									<span className="session-title">{sessionTitle}</span>
								</div>
							</div>
						) : inspectorOpen ? null : (
							<div className="session-title-row session-title-row-empty">
								<div className="session-title-copy" />
							</div>
						)}
						<div
							className="welcome-content"
							data-layout={followUpLayout ? "chat" : "empty"}
						>
							<SessionLauncher
								initialDraft={
									recoveryDraft?.id === session.agentSessionId
										? recoveryDraft.prompt
										: ""
								}
								onRecovered={async (id, prompt) => {
									const projectId = selectedProject?.id;
									if (!projectId) return;
									setRecoveryDraft({ id, prompt: prompt ?? "" });
									sessionViews.current.delete(id);
									openChat(id);
									const epoch = sessionEpoch.current;
									const next = await getCodexSession({
										data: { projectId, sessionId: id, harnessId },
									});
									if (epoch !== sessionEpoch.current) return;
									rememberSessionView(next);
									setSession(next);
									await chats.refetch();
									await agentTasks.refetch();
								}}
								childTasks={agentTasks.data ?? []}
								key={session.agentSessionId ?? "new"}
								session={session}
								competitions={competition.data ?? []}
								allowComparison={Boolean(
									activeSessionId &&
										sidebarChats.some((chat) => chat.id === activeSessionId),
								)}
								busy={composerBusy}
								listedTitle={composerDraft ? undefined : listedTitle}
								harnessId={harnessId}
								onHarnessIdChange={(id) => {
									if (session.turnStatus === "running") return;
									setHarnessId(id);
									applyRememberedClaude(id);
								}}
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
								onSend={(text, modelId, options) => {
									const epoch = sessionEpoch.current;
									// The new-chat draft starts a new chat. Forget the previously open
									// one first: applySessionView drops updates while the draft flag is
									// set or when they belong to a different open chat.
									const startsNewChat = composerDraftRef.current;
									if (startsNewChat) {
										pendingNewChatRef.current = true;
										composerDraftRef.current = false;
										selectedSessionIdRef.current = undefined;
										setComposerDraft(false);
										setProjectPickerOpen(false);
										setSelectedSessionId(undefined);
										setSession((current) => ({
											...current,
											agentSessionId: null,
											items: [],
											sideItems: [],
										}));
									}
									const scope = startsNewChat
										? { ...sessionScope(), sessionId: undefined }
										: sessionScope();
									const chatId = startsNewChat ? undefined : activeSessionId;
									if (options?.leaderCount) {
										setBusyChatIds((ids) => withBusyChat(ids, chatId));
										setSession((current) => ({
											...current,
											turnStatus: "running",
											items: sessionItemsQueuedWithUser(
												current.items,
												text,
												options.userMessageId,
											),
										}));
										void (async () => {
											try {
												if (!scope.projectId || !scope.sessionId)
													throw new Error(
														"Wait for this chat to open before sending.",
													);
												await startCompetition({
													data: {
														projectId: scope.projectId,
														rootSessionId: scope.sessionId,
														text,
														harnessId,
														modelId,
														leaderCount: options.leaderCount as number,
														attemptModelIds: [
															...(options.attemptModelIds ?? []),
														],
														userMessageId: options.userMessageId ?? "",
													},
												});
												void competition.refetch();
												void agentTasks.refetch();
											} catch (cause) {
												if (epoch === sessionEpoch.current)
													setSession((current) => ({
														...current,
														turnStatus: "failed",
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
										return;
									}
									pendingSendRef.current = {
										text,
										modelId,
										...(options?.reasoningId
											? { variant: options.reasoningId }
											: {}),
										...(options?.fast ? { fast: true } : {}),
										...(options?.mode ? { mode: options.mode } : {}),
									};
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
													return;
												}
												if (current.connection.status !== "authenticated") {
													pendingSendRef.current = null;
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
												return;
											}
											const pending = pendingSendRef.current;
											const next = await sendTask({
												data: {
													...scope,
													sessionId:
														scope.sessionId ??
														current.agentSessionId ??
														undefined,
													text,
													modelId: resolvedModel,
													...(pending?.variant
														? { variant: pending.variant }
														: {}),
													...(pending?.fast ? { fast: true } : {}),
													...(pending?.mode ? { mode: pending.mode } : {}),
												},
											});
											applySessionView(epoch, next);
											if (
												next.connection.status === "awaiting_device_code" &&
												next.connection.verificationUrl
											) {
												return;
											}
											pendingSendRef.current = null;
										} catch (cause) {
											pendingSendRef.current = null;
											pendingNewChatRef.current = false;
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
									if (activeCompetition && chatId) {
										setBusyChatIds((ids) => withBusyChat(ids, chatId));
										void stopCompetition({ data: { rootSessionId: chatId } })
											.then(() => {
												void competition.refetch();
												if (epoch === sessionEpoch.current)
													setSession((current) => ({
														...current,
														turnStatus: "failed",
													}));
												void agentTasks.refetch();
											})
											.finally(() =>
												setBusyChatIds((ids) => withoutBusyChat(ids, chatId)),
											);
										return;
									}
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
								onOpenInspector={openInspector}
								onOpenFile={openMentionedFile}
								onOpenCandidate={(id) => {
									openChat(id);
									openInspector("diff");
								}}
								projects={projects.data ?? []}
								selectedProject={selectedProject}
								onSelectProject={(id) => {
									setSelectedProjectId(id);
									setProjectPickerOpen(false);
								}}
								projectPickerOpen={projectPickerOpen}
								onProjectPickerOpenChange={setProjectPickerOpen}
							/>
							{projects.error && !projects.data && (
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
						<WorkspaceInspector
							key={activeSessionId ?? "new-session"}
							collapsed={!inspectorOpen}
							activeView={inspectorView}
							onActiveViewChange={(view) => {
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
							pullRequest={
								selectedProject?.installationId && selectedProject?.repositoryId
									? {
											installationId: selectedProject.installationId,
											repositoryId: selectedProject.repositoryId,
											number: sessionPullRequest?.number,
										}
									: undefined
							}
							overview={
								<WorkspaceOverview
									tasks={agentTasks.data ?? []}
									competitions={competition.data ?? []}
									items={session.items}
									changes={fileChanges}
									repository={selectedProject?.fullName}
									desktop={desktop}
									onOpen={openInspector}
									pullRequests={sessionPullRequests}
								/>
							}
						/>
					</div>
				</WorkspacePanes>
			</main>
		</div>
	);
}
