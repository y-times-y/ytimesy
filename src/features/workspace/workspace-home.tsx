import {
	type QueryClient,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LoaderCircle, Maximize2, Minimize2, PanelRight } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { connectedProviderId } from "#/domain/agent-connection";
import {
	backgroundPollMs,
	backgroundReadChatIds,
	backgroundRunsFromReadModel,
} from "#/domain/agent-panel";
import {
	type AgentProviderId,
	DEFAULT_COMPOSER_HARNESS_ID,
} from "#/domain/agent-provider";
import { shouldPollSubagents } from "#/domain/agent-task";
import {
	NO_SAVED_DEFAULT_BRANCHES,
	type SavedDefaultBranches,
} from "#/domain/default-branch-cookie";
import {
	ENVIRONMENT_SETUP_PROMPT,
	setupRequestKeeping,
} from "#/domain/environment-setup";
import {
	harnessLoginIsPending,
	RUNNING_TURN_POLL_MS,
	sendAfterConnect,
	sendReplyOutcome,
} from "#/domain/harness-access";
import {
	CLOSED_INSPECTOR,
	inspectorPaneIsWide,
	inspectorSplitRatio,
	type SavedInspector,
	savedInspectorCookie,
	workspaceNeedsSinglePane,
} from "#/domain/inspector-split";
import { adjacentChatId, titleWithShortcut } from "#/domain/keyboard-shortcuts";
import { memoryHoldsLine } from "#/domain/memory-marker";
import {
	base64ByteLength,
	type IncomingAttachment,
	safeAttachmentName,
} from "#/domain/message-attachment";
import { openChatCookie } from "#/domain/open-chat-cookie";
import {
	projectSetupChat,
	setupComposerPlaceholder,
	setupIndicator,
} from "#/domain/project-setup-start";
import {
	heldSendReleases,
	publicFailureMessage,
	sendWaitsForSetup,
	workspacePrepareStalled,
} from "#/domain/project-workspace";
import {
	type Project,
	projectDisplayName,
	repositoriesForProject,
	selectedProjectIdAfterDelete,
} from "#/domain/projects";
import { workspacePublicationBranch } from "#/domain/publication";
import {
	latestPullRequestHandoff,
	OPENING_PULL_REQUEST_TEXT,
} from "#/domain/pull-request-handoff-item";
import { composerSendBlock } from "#/domain/send-blocked";
import {
	chatHeaderTitle,
	composerSubmitTarget,
	fileChangesFromSessionItems,
	heldForSetupMessage,
	isTurnRunning,
	itemsKeepingMessageInFlight,
	lastAgentMessageText,
	lastUserMessageText,
	markedQueuedSend,
	messageDelivered,
	type SessionTurnStatus,
	sendWasQueued,
	sessionItemsQueuedWithUser,
	sessionTitleFromItems,
	sessionUsesFollowUpLayout,
	sessionViewAfterRecovery,
	sessionViewShouldReplaceOpenTurn,
	sessionWithoutFailedSend,
} from "#/domain/session-item";
import {
	HELD_DELIVERY_WATCH_MS,
	type LiveProgressMark,
	progressIsFresh,
	progressMatchesTurn,
	progressReopenDelayMs,
	progressRevivesStoppedTurn,
	progressStreamWanted,
	SEND_TIMEOUT_MESSAGE,
	SEND_TIMEOUT_MS,
	type SessionProgress,
	sessionReadInterval,
	WAKE_WATCH_MS,
	withinTimeout,
} from "#/domain/session-progress";
import type { SidebarPullRequest } from "#/domain/sidebar-chat-status";
import {
	backgroundTurnPollChatIds,
	chatOpenedWithProject,
	chatsToReadAhead,
	composerBusyForOpenChat,
	composerHarnessForChat,
	listedChatHarnessId,
	listedChatModelId,
	listedChatTurnStatus,
	projectsLatestChatsToReadAhead,
	SIDEBAR_PINNED_STORAGE_KEY,
	type SidebarChat,
	selectedChatIdAfterDelete,
	sessionViewAppliesToOpenChat,
	sessionWithoutOpenChat,
	sidebarChatIsRunning,
	sidebarPinnedStorageValue,
	unsentSendReturnsHere,
	visibleSidebarChats,
	withBusyChat,
	withChatHeldForSetup,
	withChatSent,
	withChatTurnStatus,
	withoutBusyChat,
} from "#/domain/sidebar-chats";
import {
	type ListedPullRequest,
	mergeAnswerPending,
	pullRequestPanelRepository,
	pullRequestsAcrossRepositories,
	savedListedPullRequest,
	sidebarChatPrMarkForWorkspace,
} from "#/domain/sidebar-pr";
import {
	NO_SAVED_SIDEBAR_PRS,
	nextSavedSidebarPrs,
	type SavedSidebarPrs,
	savedSidebarPr,
	savedSidebarPrsCookie,
	savedSidebarPrsFromCookies,
	savedSidebarPrsValue,
} from "#/domain/sidebar-pr-cookie";
import {
	progressPage,
	withEarlierPages,
	withOlderPage,
} from "#/domain/transcript-page";
import { sessionStoppedByUser } from "#/domain/turn-end";
import { replyStartedAfter } from "#/domain/web-vitals";
import {
	desktopInspectorShouldStart,
	desktopSidebarShouldOpen,
	desktopUseStreakId,
	type WorkspaceDesktop,
} from "#/domain/workspace-desktop";
import type { SettingsSection } from "#/domain/workspace-settings";
import { captureAnalytics } from "#/features/analytics/client";
import {
	finishInteraction,
	interactionTag,
	startInteraction,
} from "#/features/analytics/web-vitals";
import { SavedDefaultBranchesContext } from "#/features/sessions/base-branch-picker";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	readSavedChoices,
	showSidebarOpen,
	useFirstPaint,
	useTypedBeforeHydration,
} from "../app/first-paint";
import {
	CommandPalette,
	type CommandPaletteItem,
	ShortcutHelpDialog,
	sidebarChatIdsInOrder,
	useGlobalShortcuts,
	useShortcutHint,
} from "../app/keyboard-shortcuts";
import { closeOnPageHide, usePageRestores } from "../app/page-lifecycle";
import { authClient } from "../auth/client";
import { useImportFinishAlert } from "../local-import/use-import-finish-alert";
import { requestJson, retryTransientRead } from "../projects/api";
import {
	environmentProgressQuery,
	HeldForSetupMessage,
} from "../projects/environment-build-progress";
import { FirstProjectHeading } from "../projects/first-project-heading";
import { deleteOwnedProject } from "../projects/project.fn";
import {
	HeldForSetupContext,
	retryWorkspace,
	SetupIndicatorContext,
	type WorkspaceRetryMode,
	workspaceStatusQuery,
} from "../projects/workspace-status";
import {
	deleteProjectAgentSession,
	listProjectAgentSessions,
	listProjectAgentTasks,
	prewarmProjectAgentSession,
	startProjectAgentSession,
} from "../sessions/agent-session.fn";
import { sentPasteFields } from "../sessions/attachment-tile";
import { readBackgroundCommandsFn } from "../sessions/background-commands.fn";
import { chatCacheFor, clearChatCache } from "../sessions/chat-cache";
import { chatSideKeys } from "../sessions/chat-side-queries";
import {
	connectCodexSession,
	getCodexSession,
	getOlderSessionItems,
	type OpenChatView,
	pollCodexLogin,
	releaseQueuedSessionMessage,
	removeQueuedSessionMessage,
	sendCodexSessionTask,
	stopCodexSessionTurn,
	updateQueuedSessionMessage,
} from "../sessions/codex-session.fn";
import { MODEL_PICKER_ID } from "../sessions/harness-picker";
import {
	mcpSignInResult,
	takeMcpSignInReturn,
} from "../sessions/mcp-sign-in-return";
import type { MemoryMarkerActions } from "../sessions/memory-markers";
import {
	type ComposerSpeed,
	preferredSessionModelId,
	sessionModelsFromListed,
} from "../sessions/model-capabilities";
import {
	COMPOSER_INPUT_ID,
	type ComposerSendResult,
	SessionLauncher,
	SideChat,
} from "../sessions/session-launcher";
import { sessionReconciliationQuery } from "../sessions/session-reconciliation";
import {
	getWorkspaceDesktop,
	prepareWorkspaceDesktopFn,
	startWorkspaceDesktopFn,
} from "./desktop.fn";
import { environmentQueryKey } from "./environment-settings";
import {
	readWorkspaceChangesFn,
	resumeWorkspaceMachineFn,
} from "./explorer.fn";
import { prefetchWorkspaceFiles } from "./files-inspector";
import { UsageWarningBanner } from "./infrastructure-usage";
import { readMemoryFn, undoMemoryLineFn } from "./memory.fn";
import {
	DEFAULT_MEMORY_VIEW,
	MemoryPage,
	type MemoryView,
	prefetchMemoryPage,
	readSavedMemoryView,
} from "./memory-page";
import { ProjectSettings } from "./project-settings";
import { ProjectSidebar, type SidebarAccount } from "./project-sidebar";
import {
	listedPullRequestSummary,
	prefetchPullRequestDetail,
} from "./pull-request-detail-query";
import { chatRemoval, projectRemoval } from "./sidebar-removals";
import { useCompactLayout } from "./use-compact-layout";
import {
	askForFinishNotifications,
	useTurnFinishAlerts,
} from "./use-turn-finish-alerts";
import {
	type InspectorView,
	type ToolsView,
	WorkspaceInspector,
} from "./workspace-inspector";
import { WorkspaceOverview } from "./workspace-overview";
import { WorkspacePanes } from "./workspace-panes";
import { preloadWorkspaceTools } from "./workspace-tools-preload";

/** One composer send, from the click until the server accepts or refuses it. */
type PendingSend = {
	readonly epoch: number;
	readonly scope: {
		readonly projectId?: string;
		readonly harnessId: AgentProviderId;
		readonly sessionId?: string;
	};
	readonly chatId: string | undefined;
	readonly startsNewChat: boolean;
	readonly previousTurnStatus: SessionTurnStatus;
	readonly messageId: string;
	readonly text: string;
	readonly modelId: string;
	readonly variant?: string;
	readonly speed?: ComposerSpeed;
	readonly alternateContext?: boolean;
	readonly approvesPlan?: boolean;
	/** Continue on the fallback route the user approved after an outage. */
	readonly continueOn?: string;
	readonly attachments?: readonly IncomingAttachment[];
	/** The branch a new chat starts from, when the person picked one. */
	readonly baseBranch?: string;
	/** Sent in the chat project setup opened: it becomes a setup chat. */
	readonly environmentSetup?: boolean;
	/**
	 * Sent while the project's environment is not ready: the server holds it
	 * in the chat (persisted) and sends it once the environment is ready.
	 */
	readonly heldForSetup?: boolean;
	/** Tells the composer whether the message went out; if not it restores the draft. */
	readonly settle: (result: ComposerSendResult) => void;
};

/** How long after the open chat shows the project's other chats are read ahead. */
const READ_AHEAD_DELAY_MS = 800;
/** How long after the open chat shows the other projects' latest chats are read ahead. */
const PROJECTS_READ_AHEAD_DELAY_MS = 1_500;

/** A project's environment status, read before a switch shows it (at most every 30 s). */
function readAheadProjectStatus(queryClient: QueryClient, projectId: string) {
	void queryClient.prefetchQuery({
		...workspaceStatusQuery(projectId),
		staleTime: 30_000,
	});
}

/** How long after the inspector opens (or the chat changes) Files reads ahead. */
const FILES_READ_AHEAD_MS = 100;

/** A chat's machine is asked to wake at most this often from hovering its tools. */
const MACHINE_RESUME_INTERVAL_MS = 60_000;

/** When the Memory page and workspace tools load in the background. */
const PAGE_SETTLED_PREFETCH_MS = 2_500;

/** How long after a failed read of older turns the next one may start. */
const OLDER_RETRY_MS = 3_000;

/** When to read a completed chat again for the save hook's marker. */
const MEMORY_SAVE_RECHECK_MS = [20_000, 45_000];

/** Drops a handled link parameter from the address bar. */
function withoutSearchParam(name: string) {
	const here = new URL(window.location.href);
	here.searchParams.delete(name);
	window.history.replaceState(
		window.history.state,
		"",
		`${here.pathname}${here.search}${here.hash}`,
	);
}

/** Re-reads of a PR list while GitHub has not said whether an open PR can merge. */
const MERGE_ANSWER_READS = 5;
const MERGE_ANSWER_POLL_MS = 3_000;

export function WorkspaceHome({
	initialSession,
	initialProjects,
	initialChats,
	initialProjectChats,
	initialChatView,
	account,
	userId,
	renderedAtMs,
	savedInspector = CLOSED_INSPECTOR,
	savedPullRequests = NO_SAVED_SIDEBAR_PRS,
	savedDefaultBranches = NO_SAVED_DEFAULT_BRANCHES,
}: {
	initialSession: PublicCodexSession;
	/** The chat the page opens (a linked chat, else the latest), read with
	 * the page: it renders open. */
	initialChatView?: OpenChatView;
	/** The signed-in user, for the sidebar's account button. */
	account?: SidebarAccount;
	/** The signed-in user: the browser's chat cache is theirs alone. */
	userId?: string;
	/** When the server rendered the page: relative times hydrate from it. */
	renderedAtMs?: number;
	/** The right panel as this browser left it (a cookie the server reads). */
	savedInspector?: SavedInspector;
	/** The sidebar's PR icons as this browser last read them (a cookie the server reads). */
	savedPullRequests?: SavedSidebarPrs;
	/** Repositories' default branches as this browser last read them. */
	savedDefaultBranches?: SavedDefaultBranches;
	initialProjects?: Project[];
	/** The open project's chats (a linked chat's project, else the first),
	 * read with the page. */
	initialChats?: {
		readonly projectId: string;
		readonly chats: readonly SidebarChat[];
	};
	/** The other projects' chats, read with the page: the sidebar orders
	 * its projects and the Recent list by them from the first paint. */
	initialProjectChats?: readonly {
		readonly projectId: string;
		readonly chats: readonly SidebarChat[];
	}[];
}) {
	const firstPaint = useFirstPaint();
	const compact = useCompactLayout(firstPaint.choices.compact);
	// The server lays out a desktop; until hydrated, CSS media queries do the phone layout.
	const layoutCompact = firstPaint.hydrated && compact;
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
	const singlePane = layoutCompact || inspectorCompact || inspectorExpanded;
	const queryClient = useQueryClient();
	/** Chats opened before, kept in the browser; never part of the server's page. */
	const chatCache = useMemo(
		() => (userId ? chatCacheFor(userId) : null),
		[userId],
	);
	useEffect(() => {
		if (!chatCache) return;
		const flush = () => void chatCache.flush();
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [chatCache]);
	useState(() => {
		const key = ["agent-sessions", initialChats?.projectId];
		if (initialChats && !queryClient.getQueryData(key))
			queryClient.setQueryData(key, initialChats.chats);
		for (const group of initialProjectChats ?? []) {
			const projectKey = ["agent-sessions", group.projectId];
			if (!queryClient.getQueryData(projectKey))
				queryClient.setQueryData(projectKey, group.chats);
		}
		// The open chat's helper lines, evidence cards and recovery rows,
		// read with it: they render on the server, not in after the page loads.
		const side = initialChatView?.side;
		const projectId = initialChats?.projectId;
		const sessionId = initialChatView?.agentSessionId ?? undefined;
		if (!side || !projectId || !sessionId) return;
		const seed = (key: readonly unknown[], data: unknown) => {
			if (data !== undefined && !queryClient.getQueryData(key))
				queryClient.setQueryData(key, data);
		};
		const { turnStatus, items } = initialChatView;
		seed(chatSideKeys.tasks(projectId, sessionId), side.tasks);
		if (side.tasks)
			seed(
				chatSideKeys.background(
					sessionId,
					backgroundReadChatIds(sessionId, side.tasks),
				),
				side.background,
			);
		seed(
			chatSideKeys.evidence(projectId, sessionId, turnStatus),
			side.evidence,
		);
		seed(
			chatSideKeys.recoveryPoints(
				projectId,
				sessionId,
				items.length,
				turnStatus,
			),
			side.recoveryPoints,
		);
	});
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: () => requestJson<Project[]>("/api/projects"),
		initialData: initialProjects,
		retry: retryTransientRead,
		retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 2000),
	});
	// The project the server opened: a linked chat's, else the first.
	const [selectedProjectId, setSelectedProjectId] = useState(
		initialChats?.projectId,
	);
	const selectedProject =
		projects.data?.find((project) => project.id === selectedProjectId) ??
		projects.data?.[0];
	// Text typed before hydration stays where it was typed: in the chat the
	// server rendered, or in a new chat that the latest chat does not open over.
	const typedBeforeHydration = useTypedBeforeHydration(COMPOSER_INPUT_ID);
	const openAtLoad = initialChatView?.agentSessionId
		? { id: initialChatView.agentSessionId, view: initialChatView }
		: undefined;
	const [selectedSessionId, setSelectedSessionId] = useState(openAtLoad?.id);
	const [session, setSession] = useState(openAtLoad?.view ?? initialSession);
	const [recoveryDraft, setRecoveryDraft] = useState<{
		id: string;
		prompt: string;
	} | null>(null);
	const currentSessionRef = useRef(session);
	currentSessionRef.current = session;
	// Every repository of the project: the agent may open a PR in any of them.
	const projectRepositories = selectedProject
		? repositoriesForProject(selectedProject)
		: [];
	const repositoryPullRequests = useQueries({
		queries: projectRepositories.map((repository) => ({
			queryKey: [
				"github",
				"pull-requests",
				repository.installationId,
				repository.repositoryId,
			],
			queryFn: () =>
				requestJson<{ pullRequests: ListedPullRequest[] }>(
					`/api/github/pull-requests?installationId=${repository.installationId}&repositoryId=${repository.repositoryId}`,
				),
			enabled: Boolean(repository.installationId && repository.repositoryId),
			// GitHub works out whether an open PR can merge after the first
			// read; until it has, ask again soon instead of on the next refresh.
			refetchInterval: (query: {
				state: {
					data?: { pullRequests: ListedPullRequest[] };
					dataUpdateCount: number;
				};
			}) =>
				query.state.dataUpdateCount < MERGE_ANSWER_READS &&
				query.state.data?.pullRequests.some(mergeAnswerPending)
					? MERGE_ANSWER_POLL_MS
					: false,
		})),
	});
	const refetchPullRequests = useCallback(
		() =>
			queryClient.invalidateQueries({
				queryKey: ["github", "pull-requests"],
			}),
		[queryClient],
	);
	const chats = useQuery({
		queryKey: ["agent-sessions", selectedProject?.id],
		queryFn: () =>
			listProjectAgentSessions({
				data: { projectId: selectedProject?.id },
			}),
		enabled: Boolean(selectedProject?.id),
		// The sidebar reads every project's list (below); switching to a
		// project does not read its list again within that window.
		staleTime: 30_000,
	});
	// Every project's chats, for the sidebar's Recent list and project order;
	// the open project's list shares its cache entry with the query above.
	const projectChatLists = useQueries({
		queries: (projects.data ?? []).map((project) => ({
			queryKey: ["agent-sessions", project.id],
			queryFn: () =>
				listProjectAgentSessions({ data: { projectId: project.id } }),
			staleTime: 30_000,
		})),
	});
	const projectChats = (projects.data ?? []).map((project, index) => ({
		project,
		chats: projectChatLists[index]?.data ?? [],
	}));
	// Chats the server no longer lists (deleted elsewhere) leave the browser's cache.
	const listedChatIds = JSON.stringify(
		projectChats.flatMap(({ project }, index) =>
			projectChatLists[index]?.isSuccess
				? [[project.id, projectChats[index]?.chats.map((chat) => chat.id)]]
				: [],
		),
	);
	useEffect(() => {
		if (!chatCache) return;
		const listed = JSON.parse(listedChatIds) as [string, string[]][];
		for (const [projectId, chatIds] of listed)
			void chatCache.keepOnly(projectId, chatIds);
	}, [chatCache, listedChatIds]);
	/** The full-page Memory view from the left sidebar, in place of the chat. */
	const [memoryPageOpen, setMemoryPageOpen] = useState(false);
	/** The Memory page's view: Blocks first, then this browser's last choice. */
	const [memoryView, setMemoryView] = useState<MemoryView>(DEFAULT_MEMORY_VIEW);
	/** Opens the Memory page in its saved view, in one update: no snap. */
	const openMemoryPage = () => {
		setMemoryView(readSavedMemoryView());
		setMemoryPageOpen(true);
	};
	const startSession = useServerFn(startProjectAgentSession);
	const prewarmSession = useServerFn(prewarmProjectAgentSession);
	/** Chats whose machine copy was already asked for in this page. */
	const prewarmedChats = useRef(new Set<string>());
	const deleteSession = useServerFn(deleteProjectAgentSession);
	const deleteProject = useServerFn(deleteOwnedProject);
	const removeChat = useMutation(chatRemoval(queryClient, deleteSession));
	const removeOwnedProject = useMutation(
		projectRemoval(queryClient, deleteProject),
	);
	const [projectsOpen, setProjectsOpen] = useState(
		firstPaint.choices.sidebarOpen,
	);
	// <html data-sidebar> lays the sidebar out (the first-paint script set it).
	const shownProjectsOpen = firstPaint.hydrated && projectsOpen;
	const [inspectorOpen, setInspectorOpen] = useState(savedInspector.open);
	const [inspectorView, setInspectorView] = useState<InspectorView>(
		savedInspector.view,
	);
	const [selectedFilePath, setSelectedFilePath] = useState<string>();
	/** The memory file a chat's memory marker asked the Memory tab to show. */
	const [memoryFocus, setMemoryFocus] = useState<{ path: string }>();
	const [customSplit, setCustomSplit] = useState<number | null>(
		savedInspector.split,
	);
	// A saved open panel where it would cover the chat (a phone, a narrow
	// window) closes as the page hydrates; CSS already shows it closed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, as the page hydrates.
	useLayoutEffect(() => {
		const width = workspaceMainRef.current?.getBoundingClientRect().width;
		if (
			firstPaint.choices.compact ||
			(width !== undefined && workspaceNeedsSinglePane(width))
		)
			setInspectorOpen(false);
	}, []);
	// The next page load renders the right panel as it is now. Only the
	// side-by-side layout saves it: on a phone it covers the chat instead.
	useEffect(() => {
		if (!firstPaint.hydrated || singlePane) return;
		// biome-ignore lint/suspicious/noDocumentCookie: one small cookie; cookieStore is missing in older Safari.
		document.cookie = savedInspectorCookie({
			open: inspectorOpen,
			view: inspectorView,
			split: customSplit,
		});
	}, [
		firstPaint.hydrated,
		singlePane,
		inspectorOpen,
		inspectorView,
		customSplit,
	]);
	const [busyChatIds, setBusyChatIds] = useState<string[]>([]);
	const [harnessId, setHarnessId] = useState<AgentProviderId>(() =>
		openAtLoad
			? composerHarnessForChat({
					listedHarnessId: initialChats?.chats.find(
						(chat) => chat.id === openAtLoad.id,
					)?.harnessId,
					connectionProvider: connectedProviderId(openAtLoad.view.connection),
					fallback: DEFAULT_COMPOSER_HARNESS_ID,
				})
			: DEFAULT_COMPOSER_HARNESS_ID,
	);
	const [desktop, setDesktop] = useState<WorkspaceDesktop>({
		status: "stopped",
	});
	const [desktopBusy, setDesktopBusy] = useState(false);
	/** The chat whose desktop is starting; another chat may still start its own. */
	const desktopStartFor = useRef<string | null>(null);
	/** A chat whose Desktop was clicked while its quiet warm-up was running. */
	const desktopClickedWhileWarming = useRef<string | null>(null);
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
	const [composerDraft, setComposerDraft] = useState(
		!openAtLoad && typedBeforeHydration !== "",
	);
	const [projectPickerOpen, setProjectPickerOpen] = useState(false);
	const composerDraftRef = useRef(false);
	composerDraftRef.current = composerDraft;
	/** Set from a draft send until its new chat's first view arrives. */
	const pendingNewChatRef = useRef(false);
	const sessionEpoch = useRef(0);
	/** The epoch in which New chat is creating a chat; nothing else gets selected meanwhile. */
	const creatingChatEpoch = useRef<number | null>(null);
	/** The chat New chat created last; its composer is the one the person typed into meanwhile. */
	const createdChatId = useRef<string | null>(null);
	/**
	 * The composer is keyed by its chat, except that New chat's chat keeps the
	 * composer it showed while being created: the text typed (and the focus)
	 * in that half second survive the chat getting its id.
	 */
	const composerKey = useRef({
		chatId: null as string | null,
		key: "new",
		n: 0,
	});
	if (composerKey.current.chatId !== session.agentSessionId) {
		const previous = composerKey.current;
		const n = previous.n + 1;
		composerKey.current = {
			chatId: session.agentSessionId,
			key:
				previous.chatId === null &&
				session.agentSessionId === createdChatId.current
					? previous.key
					: (session.agentSessionId ?? `new:${n}`),
			n,
		};
	}
	const selectedSessionIdRef = useRef<string | undefined>(undefined);
	/** A send waiting for the ChatGPT device code to be entered. */
	const pendingSendRef = useRef<PendingSend | null>(null);
	const [composerPrefill, setComposerPrefill] = useState<{
		readonly text: string;
		readonly at: number;
		readonly send?: boolean;
		readonly messageId?: string;
	}>();
	// The message box takes it in its own effect (children's run first); it
	// must not come back when another chat's box mounts later. One to send
	// by itself stays until the box sends it (the box can remount while its
	// chat is created), and only for the chat it was made for.
	useEffect(() => {
		if (composerPrefill && !composerPrefill.send) setComposerPrefill(undefined);
	}, [composerPrefill]);
	/**
	 * The chat view project setup opened (its session epoch): its sends are
	 * flagged as a setup chat. Opening another chat moves the epoch on.
	 */
	const environmentSetupEpochRef = useRef<number | null>(null);
	// A message sent while the project's environment is still being set up
	// shows in the chat with the setup's progress, then goes by itself. A
	// failed setup keeps it there (Retry, Send anyway); it is never dropped.
	const heldForSetupRef = useRef<PendingSend | null>(null);
	const [heldForSetup, setHeldForSetup] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/**
	 * The open chat's held message once the environment is ready: the server
	 * sends it, and the chat is read until its turn shows (an idle chat has
	 * no stream or poll that would bring it).
	 */
	const [awaitedHeld, setAwaitedHeld] = useState<{
		readonly chatId: string;
		readonly messageId: string;
		readonly since: number;
	} | null>(null);
	const awaitedHeldRef = useRef(awaitedHeld);
	awaitedHeldRef.current = awaitedHeld;
	const [heldMessage, setHeldMessage] = useState<{
		readonly projectId: string;
		readonly messageId: string;
		readonly text: string;
		readonly startsNewChat: boolean;
	} | null>(null);
	/** The chat the user pressed Stop in; its idle view then unlocks the composer. */
	const stopRequestedFor = useRef<string | null>(null);
	// Rendered: the chat whose Stop request has not answered yet.
	const [stoppingChatId, setStoppingChatId] = useState<string | null>(null);
	const abandonSendRef = useRef<
		(pending: PendingSend, message: string | null) => void
	>(() => undefined);
	const deliverSendRef = useRef<
		(pending: PendingSend, view: PublicCodexSession) => Promise<void>
	>(async () => undefined);
	const sessionViews = useRef(new Map<string, PublicCodexSession>());
	/** Held views that came from the browser's cache, not yet read again. */
	const restoredChats = useRef(new Set<string>());
	/** The epoch whose open chat has shown a server view (a cached one then stays out). */
	const serverViewEpoch = useRef(-1);
	// The chat the server rendered open is held like a read one: nothing reads it again now.
	useState(() => {
		if (!openAtLoad || !initialChats) return;
		sessionViews.current.set(openAtLoad.id, openAtLoad.view);
		const { queryKey } = sessionReconciliationQuery(
			{
				projectId: initialChats.projectId,
				sessionId: openAtLoad.id,
				harnessId: listedChatHarnessId(
					initialChats.chats,
					openAtLoad.id,
					harnessId,
				),
			},
			sessionEpoch.current,
		);
		queryClient.setQueryData(queryKey, {
			epoch: sessionEpoch.current,
			view: openAtLoad.view,
		});
	});
	/** Chat views being read ahead of a click, by chat id; an open takes them over. */
	const viewReads = useRef(
		new Map<string, Promise<PublicCodexSession | null>>(),
	);
	/** The open chat's read: one already under way (a hover, the page's first chat), else a new one. */
	const readOpenChat = useCallback(
		async (selection: {
			projectId: string;
			sessionId: string;
			harnessId: AgentProviderId;
		}) =>
			(await viewReads.current.get(selection.sessionId)) ??
			getCodexSession({ data: selection }),
		[],
	);
	// The page's latest chat is read before the page's other reads queue
	// ahead of it; opening it then takes this read over.
	useLayoutEffect(() => {
		const first = initialChats?.chats[0];
		if (first) readAheadRef.current(first.id);
	}, [initialChats]);
	const bumpSessionEpoch = useCallback(() => {
		sessionEpoch.current += 1;
		return sessionEpoch.current;
	}, []);
	const rememberSessionView = useCallback(
		(next: PublicCodexSession) => {
			if (!next.agentSessionId) return;
			// Older pages the reader loaded stay with the chat's newer view.
			sessionViews.current.set(
				next.agentSessionId,
				withEarlierPages(sessionViews.current.get(next.agentSessionId), next),
			);
			restoredChats.current.delete(next.agentSessionId);
			if (!selectedProject?.id) return;
			chatCache?.write(selectedProject.id, next);
			const chatId = next.agentSessionId;
			queryClient.setQueryData(
				["agent-sessions", selectedProject.id],
				(current: readonly SidebarChat[] | undefined) =>
					withChatTurnStatus(current ?? [], chatId, next.turnStatus),
			);
		},
		[queryClient, selectedProject?.id, chatCache],
	);
	const liveProgress = useRef<LiveProgressMark>(null);
	/** The chat whose progress stream is open now (its view is then read rarely). */
	const progressStreamOpen = useRef<string | null>(null);
	const refetchOpenSession = useRef<() => unknown>(() => {});
	/** The open project's setup chat (the server starts it; it never opens by itself). */
	const setupChatIdRef = useRef<string | undefined>(undefined);
	const applySessionView = useCallback(
		(epoch: number, next: PublicCodexSession) => {
			if (epoch !== sessionEpoch.current) return;
			if (composerDraftRef.current) return;
			// With no chat open (a new project's empty chat), the setup chat's
			// view never lands on the person's composer: its running turn would
			// make their Send a queue or a stop.
			if (
				!selectedSessionIdRef.current &&
				next.agentSessionId &&
				next.agentSessionId === setupChatIdRef.current
			)
				return;
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
			serverViewEpoch.current = epoch;
			setSession((current) => {
				if (
					next.turnStatus === "running" &&
					progressIsFresh(liveProgress.current, next.agentSessionId, Date.now())
				)
					next = {
						...next,
						items: current.items,
						hasOlderItems: current.hasOlderItems,
					};
				// The server sends the chat's last turns; older ones read stay above.
				next = withEarlierPages(current, next);
				// A view from before the stop settled must not bring the stopped turn back.
				if (
					progressRevivesStoppedTurn({
						stopRequested: Boolean(
							next.agentSessionId &&
								stopRequestedFor.current === next.agentSessionId,
						),
						current: current.items,
						next: next.items,
						nextStatus: next.turnStatus,
					})
				)
					return current;
				const awaited = awaitedHeldRef.current;
				if (
					awaited &&
					awaited.chatId === next.agentSessionId &&
					current.agentSessionId === next.agentSessionId
				)
					next = {
						...next,
						items: [
							...itemsKeepingMessageInFlight(
								current.items,
								next.items,
								awaited.messageId,
							),
						],
					};
				if (
					!sessionViewShouldReplaceOpenTurn({
						currentStatus: current.turnStatus,
						nextStatus: next.turnStatus,
						currentItems: current.items,
						nextItems: next.items,
						stopRequested: Boolean(
							next.agentSessionId &&
								stopRequestedFor.current === next.agentSessionId,
						),
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
	const stopTurn = useServerFn(stopCodexSessionTurn);
	const removeQueued = useServerFn(removeQueuedSessionMessage);
	const updateQueued = useServerFn(updateQueuedSessionMessage);
	const releaseQueued = useServerFn(releaseQueuedSessionMessage);
	const loadDesktop = useServerFn(getWorkspaceDesktop);
	const startDesktop = useServerFn(startWorkspaceDesktopFn);
	const prepareDesktop = useServerFn(prepareWorkspaceDesktopFn);
	const readChanges = useServerFn(readWorkspaceChangesFn);
	const resumeMachine = useServerFn(resumeWorkspaceMachineFn);
	/** When this page last asked each chat's machine to wake. */
	const resumedMachines = useRef(new Map<string, number>());
	/**
	 * The page's first chat has been read. The slower side reads (git changes,
	 * the desktop's state, each a machine call) wait for it, so the page's
	 * first transcript does not queue behind them.
	 */
	const [firstChatRead, setFirstChatRead] = useState(false);
	// Git in the workspace is the source of truth for what changed; the
	// transcript only fills in while the machine is asleep. Only the right
	// panel shows git's changes: while it is closed, a switch reads none.
	const gitChanges = useQuery({
		queryKey: ["workspace-changes", selectedProject?.id, selectedSessionId],
		queryFn: () =>
			readChanges({
				data: { projectId: selectedProject?.id, sessionId: selectedSessionId },
			}),
		enabled: Boolean(
			selectedProject?.id &&
				selectedSessionId &&
				firstChatRead &&
				inspectorOpen,
		),
		refetchInterval: session.turnStatus === "running" ? 10_000 : 60_000,
		staleTime: 5_000,
	});
	const refetchChanges = gitChanges.refetch;
	const gitChangesShown = useRef(inspectorOpen);
	gitChangesShown.current = inspectorOpen;
	const changesTurnStatus = useRef(session.turnStatus);
	useEffect(() => {
		const was = changesTurnStatus.current;
		changesTurnStatus.current = session.turnStatus;
		// A finished turn is when the agent's edits settle; show them right away.
		if (
			gitChangesShown.current &&
			isTurnRunning(was) &&
			!isTurnRunning(session.turnStatus)
		)
			void refetchChanges();
	}, [session.turnStatus, refetchChanges]);
	const fileChanges =
		gitChanges.data ?? fileChangesFromSessionItems(session.items);
	const splitRatio = inspectorSplitRatio({
		custom: customSplit,
		wide: inspectorPaneIsWide(inspectorView),
	});
	const sessionTitle = sessionTitleFromItems(session.items);
	const hasUserMessage = Boolean(lastUserMessageText(session.items));
	const listedPullRequests = pullRequestsAcrossRepositories(
		projectRepositories.map((repository, index) => ({
			repository,
			pullRequests: repositoryPullRequests[index]?.data?.pullRequests,
		})),
	);
	// Until every repository's PR list is read (it comes from GitHub after the
	// page loads), rows keep the PR this browser saw last, as the server
	// rendered them; then the live list decides.
	const pullRequestsRead = projectRepositories.every(
		(repository, index) =>
			!(repository.installationId && repository.repositoryId) ||
			repositoryPullRequests[index]?.data !== undefined ||
			repositoryPullRequests[index]?.isError,
	);
	const sidebarChats = (chats.data ?? []).map((chat) => {
		if (!pullRequestsRead)
			return { ...chat, pr: savedSidebarPr(savedPullRequests, chat.id) };
		const mark = sidebarChatPrMarkForWorkspace({
			workspaceId: chat.workspaceId,
			workingBranch: chat.workingBranch,
			pullRequests: listedPullRequests,
		});
		return { ...chat, pr: mark?.pr ?? null };
	});
	// The next page load renders the rows with the PRs read now.
	const livePrMarks =
		pullRequestsRead && chats.data
			? JSON.stringify(sidebarChats.map((chat) => [chat.id, chat.pr ?? null]))
			: null;
	useEffect(() => {
		if (!livePrMarks) return;
		const listed = (
			JSON.parse(livePrMarks) as [string, SidebarPullRequest | null][]
		).map(([id, pr]) => ({ id, pr }));
		const saved = savedSidebarPrsFromCookies(document.cookie);
		const next = nextSavedSidebarPrs(saved, listed);
		if (savedSidebarPrsValue(next) === savedSidebarPrsValue(saved)) return;
		// biome-ignore lint/suspicious/noDocumentCookie: one small cookie; cookieStore is missing in older Safari.
		document.cookie = savedSidebarPrsCookie(next);
	}, [livePrMarks]);
	const activeProjectId = selectedProject?.id;
	const activeSessionId =
		selectedSessionId ?? session.agentSessionId ?? undefined;
	// A reload opens this chat again (open-chat-cookie.ts).
	useEffect(() => {
		// biome-ignore lint/suspicious/noDocumentCookie: one small cookie; cookieStore is missing in older Safari.
		document.cookie = openChatCookie(activeProjectId, activeSessionId);
	}, [activeProjectId, activeSessionId]);
	const agentTasks = useQuery({
		queryKey: chatSideKeys.tasks(activeProjectId, activeSessionId),
		queryFn: () =>
			listProjectAgentTasks({
				data: {
					projectId: activeProjectId,
					rootSessionId: activeSessionId,
				},
			}),
		enabled: Boolean(activeProjectId && activeSessionId),
		refetchInterval: (query) =>
			shouldPollSubagents(session.turnStatus, query.state.data ?? [])
				? 2_500
				: false,
	});
	// Background commands of the chat and its helpers, for the agents list.
	const backgroundChatIds = backgroundReadChatIds(
		activeSessionId,
		agentTasks.data ?? [],
	);
	const agentsWorking = shouldPollSubagents(
		session.turnStatus,
		agentTasks.data ?? [],
	);
	const backgroundCommands = useQuery({
		queryKey: chatSideKeys.background(activeSessionId, backgroundChatIds),
		queryFn: () =>
			readBackgroundCommandsFn({ data: { sessionIds: backgroundChatIds } }),
		enabled: Boolean(activeProjectId && backgroundChatIds.length),
		// A new helper changes the key; keep this chat's rows until it reads.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === activeSessionId ? previous : undefined,
		refetchInterval: (query) =>
			backgroundPollMs({
				agentsWorking,
				running: Object.values(query.state.data ?? {}).reduce(
					(count, commands) => count + commands.length,
					0,
				),
			}),
	});
	const backgroundRuns = backgroundRunsFromReadModel(
		backgroundCommands.data ?? {},
	);
	// A helper's report or a background command's exit starts Main's next turn
	// on the server; the open chat listens for it (progressStreamWanted), and
	// for a stopped turn's settled transcript.
	const helpersWorking = (agentTasks.data ?? []).some(
		(task) => task.status === "working" || task.status === "waiting",
	);
	const backgroundRunning = backgroundRuns.some(
		(run) => run.status === "running",
	);
	const [wakeWatch, setWakeWatch] = useState<{
		readonly sessionId: string;
		readonly since: number;
	} | null>(null);
	const sideWork = useRef<{
		readonly sessionId: string | undefined;
		readonly active: boolean;
	}>({ sessionId: undefined, active: false });
	useEffect(() => {
		const active = helpersWorking || backgroundRunning;
		const previous = sideWork.current;
		sideWork.current = { sessionId: activeSessionId, active };
		if (
			activeSessionId &&
			previous.sessionId === activeSessionId &&
			previous.active &&
			!active
		)
			setWakeWatch({ sessionId: activeSessionId, since: Date.now() });
	}, [activeSessionId, helpersWorking, backgroundRunning]);
	useEffect(() => {
		if (!wakeWatch) return;
		const timer = window.setTimeout(() => setWakeWatch(null), WAKE_WATCH_MS);
		return () => window.clearTimeout(timer);
	}, [wakeWatch]);
	// The newest turn's pull request handoff, which finishes after the turn
	// shows as done: "Opening pull request…", then the pull request.
	const pullRequestHandoff = latestPullRequestHandoff(
		session.items,
		isTurnRunning(session.turnStatus),
		Date.now(),
	);
	const listenForProgress = progressStreamWanted({
		turnRunning: session.turnStatus === "running",
		helpersWorking,
		watchingForWake: !!wakeWatch && wakeWatch.sessionId === activeSessionId,
		openingPullRequest: pullRequestHandoff?.state === "opening",
	});
	// The pull request arrived over the progress stream: the PR list and the
	// chat's row read it now instead of at their next refresh.
	const handedOffPullRequestUrl =
		pullRequestHandoff?.state === "opened" ? pullRequestHandoff.url : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reads again only when a new pull request link arrives.
	useEffect(() => {
		if (!handedOffPullRequestUrl) return;
		void refetchPullRequests();
		void chats.refetch();
	}, [handedOffPullRequestUrl]);
	const settledTurn = useRef<{
		readonly chatId?: string;
		readonly status: SessionTurnStatus;
	}>({ status: "idle" });
	useEffect(() => {
		const previous = settledTurn.current;
		settledTurn.current = {
			chatId: activeSessionId,
			status: session.turnStatus,
		};
		// A turn that just finished here settles its helpers, commands, PR and
		// title; opening an already finished chat reads nothing extra.
		if (
			activeSessionId &&
			previous.chatId === activeSessionId &&
			isTurnRunning(previous.status) &&
			(session.turnStatus === "completed" || session.turnStatus === "failed")
		) {
			void agentTasks.refetch();
			void backgroundCommands.refetch();
			void refetchPullRequests();
			void chats.refetch();
		}
	}, [
		activeSessionId,
		session.turnStatus,
		agentTasks.refetch,
		backgroundCommands.refetch,
		refetchPullRequests,
		chats.refetch,
	]);
	selectedSessionIdRef.current = activeSessionId;
	/** Starts this chat's desktop; ahead of a click, only on an existing machine. */
	const requestDesktop = useCallback(
		(ahead = false) => {
			const chatId = activeSessionId;
			if (!chatId) return;
			if (desktopStartFor.current === chatId) {
				// A click during the quiet warm-up shows the start; the warm-up's
				// result lands, or a real start follows if it found no machine.
				if (!ahead) {
					desktopClickedWhileWarming.current = chatId;
					setDesktop({ status: "starting" });
				}
				return;
			}
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
			desktopStartFor.current = chatId;
			setDesktopBusy(true);
			// A warm-up ahead of a click runs quietly: nobody asked for the
			// desktop yet, so the panel keeps saying it is not running.
			if (!ahead) setDesktop({ status: "starting" });
			// A result belongs to the chat that asked; a chat opened since keeps its own.
			const stillOpen = () => selectedSessionIdRef.current === chatId;
			const data = { projectId: selectedProject?.id, sessionId: chatId };
			void (ahead ? prepareDesktop : startDesktop)({ data })
				.then((next) => {
					const clicked = desktopClickedWhileWarming.current === chatId;
					desktopClickedWhileWarming.current = null;
					if (clicked && next.status === "stopped")
						return startDesktop({ data });
					return next;
				})
				.then((next) => {
					if (stillOpen()) setDesktop(next);
				})
				.catch((cause) => {
					if (stillOpen())
						setDesktop({
							status: "failed",
							reason: publicFailureMessage(cause),
						});
				})
				.finally(() => {
					if (desktopStartFor.current === chatId)
						desktopStartFor.current = null;
					if (stillOpen()) setDesktopBusy(false);
				});
		},
		[
			activeSessionId,
			desktop,
			desktopBusy,
			selectedProject?.id,
			startDesktop,
			prepareDesktop,
		],
	);
	const requestDesktopRef = useRef(requestDesktop);
	requestDesktopRef.current = requestDesktop;
	useEffect(() => {
		// Another chat's desktop start never blocks this chat's.
		void activeSessionId;
		setDesktopBusy(false);
	}, [activeSessionId]);
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
	// Read from the server's list, so the first paint already shows it.
	const noProjects = projects.data?.length === 0;

	function sessionScope() {
		return {
			projectId: activeProjectId,
			harnessId,
			sessionId: activeSessionId,
		};
	}

	// A phone's drawer starts closed; back on a wide screen the pinned choice returns.
	useEffect(() => {
		setProjectsOpen(!compact && readSavedChoices().sidebarOpen);
	}, [compact]);

	useEffect(() => {
		if (compact) return;
		try {
			window.localStorage.setItem(
				SIDEBAR_PINNED_STORAGE_KEY,
				sidebarPinnedStorageValue(projectsOpen),
			);
		} catch {
			// The choice then holds for this page only.
		}
	}, [compact, projectsOpen]);

	useLayoutEffect(() => {
		showSidebarOpen(projectsOpen);
	}, [projectsOpen]);

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

	// `/?chat=<id>` and `/?project=<id>&chat=<id>` (memory sources, GitHub
	// wake-ups): the server renders that chat open. The link leaves the
	// address bar; a chat the server could not open (not listed yet) opens
	// here once its project's list has it.
	const linkedProject = useRef(
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get("project"),
	);
	useEffect(() => {
		const id = linkedProject.current;
		if (!id || !projects.data?.some((project) => project.id === id)) return;
		linkedProject.current = null;
		withoutSearchParam("project");
		selectProject(id);
	});
	const linkedChat = useRef(
		typeof window === "undefined"
			? null
			: new URLSearchParams(window.location.search).get("chat"),
	);
	useEffect(() => {
		const id = linkedChat.current;
		if (!id || !chats.data?.some((chat) => chat.id === id)) return;
		linkedChat.current = null;
		withoutSearchParam("chat");
		if (activeSessionId !== id) openChat(id);
	});

	// The project the open chat belongs to; the chat the server rendered open
	// stays open as the page hydrates.
	const chatsProjectId = useRef(activeProjectId);
	useEffect(() => {
		if (chatsProjectId.current === activeProjectId) return;
		chatsProjectId.current = activeProjectId;
		// Chat views stay cached by chat id: going back to another project's
		// chat shows it at once.
		setSelectedSessionId(undefined);
		setSelectedFilePath(undefined);
	}, [activeProjectId]);

	// Nothing open when the project's list arrives (or changes): its latest
	// chat opens, never its setup chat (chatOpenedWithProject). The setup
	// chat the background start creates, or its turn starting or asking for
	// something, never takes the screen from a new empty chat.
	useEffect(() => {
		if (
			// A chat is open, or opened since this render (a linked chat).
			selectedSessionIdRef.current ||
			selectedSessionId ||
			pendingNewChatRef.current ||
			creatingChatEpoch.current === sessionEpoch.current
		)
			return;
		const first = chatOpenedWithProject({ chats: chats.data, composerDraft });
		if (!first) return;
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

	// The desktop's state shows in the right panel only: read it once the
	// panel is open, not on every chat or project switch.
	useEffect(() => {
		if (
			!activeProjectId ||
			!activeSessionId ||
			!firstChatRead ||
			!inspectorOpen
		)
			return;
		void loadDesktop({
			data: { projectId: activeProjectId, sessionId: activeSessionId },
		}).then((next) => {
			// Another chat opened meanwhile keeps its own desktop.
			if (selectedSessionIdRef.current !== activeSessionId) return;
			setDesktop((current) =>
				current.status === "starting" || current.status === "running"
					? current
					: next,
			);
			// Started while the panel is open, so Desktop is up by the time it
			// is clicked instead of starting then.
			if (next.status === "stopped") requestDesktopRef.current(true);
		});
	}, [
		loadDesktop,
		activeProjectId,
		activeSessionId,
		firstChatRead,
		inspectorOpen,
	]);

	// A desktop-use streak opens this panel on Desktop. Closing the sidebar
	// records that streak, so later frames of it stay closed; the next streak
	// (the desktop went idle, then the agent used it again) opens it.
	const desktopStreak = desktopUseStreakId({
		turnStatus: session.turnStatus,
		items: session.items,
	});
	const desktopStreakRef = useRef(desktopStreak);
	desktopStreakRef.current = desktopStreak;
	const dismissedDesktopStreak = useRef(new Map<string, string>());
	const followedDesktopStreak = useRef<string | null>(null);
	const followedSessionId = useRef(activeSessionId);
	followedSessionId.current = activeSessionId;
	useEffect(() => {
		if (!desktopStreak || !activeProjectId || !activeSessionId) return;
		const followKey = `${activeSessionId}\n${desktopStreak}`;
		// Once per streak: a later frame must not pull the panel back open,
		// and a re-run (a new desktop read) must not skip catching the desktop up.
		if (followedDesktopStreak.current !== followKey) {
			followedDesktopStreak.current = followKey;
			if (
				desktopSidebarShouldOpen({
					streakId: desktopStreak,
					dismissedStreakId:
						dismissedDesktopStreak.current.get(activeSessionId) ?? null,
				})
			) {
				setInspectorView("desktop");
				setInspectorOpen(true);
			}
		}
		let attempts = 0;
		let timer = 0;
		const refresh = () =>
			void loadDesktop({
				data: { projectId: activeProjectId, sessionId: activeSessionId },
			}).then((next) => {
				if (followedSessionId.current !== activeSessionId) return;
				if (next.status === "running") setDesktop(next);
				// The desktop may still be starting when the first tool call shows.
				else if (++attempts < 12) timer = window.setTimeout(refresh, 5_000);
			});
		refresh();
		return () => window.clearTimeout(timer);
	}, [desktopStreak, activeProjectId, activeSessionId, loadDesktop]);
	function toggleInspectorPanel() {
		setInspectorOpen((open) => {
			const streak = desktopStreakRef.current;
			const sessionId = followedSessionId.current;
			if (open && streak && sessionId)
				dismissedDesktopStreak.current.set(sessionId, streak);
			return !open;
		});
	}

	const pollSession =
		harnessLoginIsPending(session.connection) ||
		isTurnRunning(session.turnStatus);
	const awaitingHeldDelivery =
		awaitedHeld !== null &&
		awaitedHeld.chatId === activeSessionId &&
		!messageDelivered(session.items, awaitedHeld.messageId);
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
			readOpenChat,
		),
		enabled: Boolean(
			activeProjectId && activeSessionId && !composerDraft && !composerBusy,
		),
		// Progress arrives on the stream while it is open; polling stands in
		// only while it is not.
		refetchInterval: () =>
			sessionReadInterval({
				polling: pollSession,
				streamOpen:
					!!activeSessionId && progressStreamOpen.current === activeSessionId,
				pollMs: RUNNING_TURN_POLL_MS,
				awaitingHeldDelivery,
			}),
		refetchIntervalInBackground: true,
	});
	refetchOpenSession.current = () => void sessionRead.refetch();
	useEffect(() => {
		if (sessionRead.isFetched) setFirstChatRead(true);
	}, [sessionRead.isFetched]);
	// Speed reports (web-vitals.ts): a switched-to chat shows its transcript,
	// or its empty view once read; a sent message gets the agent's first output.
	const switchedChatShown =
		Boolean(activeSessionId) &&
		session.agentSessionId === activeSessionId &&
		(session.items.length > 0 || sessionRead.isFetched);
	useEffect(() => {
		if (switchedChatShown && activeSessionId) finishInteraction("chat_switch");
	}, [switchedChatShown, activeSessionId]);
	useEffect(() => {
		const sent = interactionTag("first_token");
		if (sent && replyStartedAfter(session.items, sent))
			finishInteraction("first_token");
	}, [session.items]);
	// Once the open chat has shown, the project's latest chats are read two
	// at a time, so switching to one shows its transcript at once.
	const latestChatIds = sessionRead.data
		? (chats.data ?? []).map((chat) => chat.id).join(",")
		: "";
	useEffect(() => {
		if (!latestChatIds) return;
		const queue = chatsToReadAhead({
			chats: latestChatIds.split(",").map((id) => ({ id })),
			openChatId: activeSessionId,
			heldChatIds: new Set([
				...[...sessionViews.current.keys()].filter(
					(id) => !restoredChats.current.has(id),
				),
				...viewReads.current.keys(),
			]),
		});
		let stopped = false;
		const next = async (): Promise<void> => {
			const id = queue.shift();
			if (stopped || !id) return;
			readAheadRef.current(id);
			await viewReads.current.get(id);
			return next();
		};
		const timer = window.setTimeout(() => {
			void next();
			void next();
		}, READ_AHEAD_DELAY_MS);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [latestChatIds, activeSessionId]);
	// Then each other project's latest chat, one at a time: switching
	// projects opens it from the held view instead of waiting for a read.
	const otherProjectsLatest = sessionRead.data
		? projectChats
				.filter(({ project }) => project.id !== activeProjectId)
				.map(({ chats }) => chats[0]?.id ?? "")
				.join(",")
		: "";
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the listed ids; the lists are read when the timer fires.
	useEffect(() => {
		if (!otherProjectsLatest) return;
		let stopped = false;
		const timer = window.setTimeout(async () => {
			for (const { project } of projectChats)
				if (project.id !== activeProjectId)
					readAheadProjectStatus(queryClient, project.id);
			const queue = projectsLatestChatsToReadAhead({
				projects: projectChats.map(({ project, chats }) => ({
					projectId: project.id,
					chats,
				})),
				openProjectId: activeProjectId,
				heldChatIds: new Set([
					...[...sessionViews.current.keys()].filter(
						(id) => !restoredChats.current.has(id),
					),
					...viewReads.current.keys(),
				]),
			});
			for (const id of queue) {
				if (stopped) return;
				readAheadRef.current(id);
				await viewReads.current.get(id);
			}
		}, PROJECTS_READ_AHEAD_DELAY_MS);
		return () => {
			stopped = true;
			window.clearTimeout(timer);
		};
	}, [otherProjectsLatest, activeProjectId]);
	// The Memory page reads a git snapshot (about a second); read it once the
	// page has settled, and the workspace tools' code, so each opens at once.
	const pageSettled = Boolean(sessionRead.data) || !activeSessionId;
	const settledPrefetch = useRef(false);
	useEffect(() => {
		if (!pageSettled || settledPrefetch.current) return;
		const timer = window.setTimeout(() => {
			settledPrefetch.current = true;
			prefetchMemoryPage(queryClient);
			preloadWorkspaceTools();
		}, PAGE_SETTLED_PREFETCH_MS);
		return () => window.clearTimeout(timer);
	}, [pageSettled, queryClient]);
	// The save hook commits shortly after a turn completes and records its
	// marker on the chat; read the chat again so it shows without a reload.
	const memoryInChat = session.items.some(
		(item) => item.kind === "userMessage" && item.memory,
	);
	const lastTurnStatus = useRef(session.turnStatus);
	useEffect(() => {
		const was = lastTurnStatus.current;
		lastTurnStatus.current = session.turnStatus;
		if (
			!memoryInChat ||
			!isTurnRunning(was) ||
			session.turnStatus !== "completed"
		)
			return;
		const timers = MEMORY_SAVE_RECHECK_MS.map((delay) =>
			window.setTimeout(() => void sessionRead.refetch(), delay),
		);
		return () => {
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [session.turnStatus, memoryInChat, sessionRead.refetch]);
	const readMemory = useServerFn(readMemoryFn);
	const undoMemoryLine = useServerFn(undoMemoryLineFn);
	const savedMemoryShown = session.items.some(
		(item) => item.kind === "memorySave",
	);
	const memoryFiles = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: savedMemoryShown,
	});
	const memoryActions: MemoryMarkerActions = {
		onOpenMemory: (path) => {
			setMemoryFocus({ path });
			openInspector("memory");
		},
		onOpenChat: (chatId) => {
			if (!sidebarChats.some((chat) => chat.id === chatId)) return false;
			openChat(chatId);
			return true;
		},
		holds: (line) => {
			const files = memoryFiles.data?.files;
			if (!files) return undefined;
			return memoryHoldsLine(
				Object.fromEntries(files.map((file) => [file.path, file.content])),
				line,
			);
		},
		onUndo: async (line) => {
			const result = await undoMemoryLine({ data: line });
			await queryClient.invalidateQueries({ queryKey: ["memory"] });
			return result;
		},
	};
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
	const handledLogin = useRef<object | null>(null);
	const codexLogin = useQuery({
		queryKey: ["codex-device-login"],
		queryFn: () => pollLogin({ data: {} }),
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
		// A cached result is seen again when the open chat changes; act on it once.
		const pending =
			handledLogin.current === login ? null : pendingSendRef.current;
		handledLogin.current = login;
		if (login.status !== "connected") {
			// No sign-in, so nothing is sent; the composer gets the message back.
			if (pending) abandonSendRef.current(pending, null);
			return;
		}
		void queryClient.invalidateQueries({ queryKey: ["agent-model-catalog"] });
		void getCodexSession({
			data: {
				projectId: activeProjectId ?? undefined,
				sessionId: activeSessionId ?? undefined,
				harnessId: "codex",
			},
		})
			.then((next) => {
				setSession((current) => ({
					...current,
					connection: next.connection,
					models: next.models,
					canSend: next.canSend,
				}));
				return next;
			})
			.catch(() => currentSessionRef.current)
			.then((next) => {
				// Signed in: now send the message that asked for the sign-in.
				if (pending && pendingSendRef.current === pending)
					void deliverSendRef.current(pending, next);
			});
	}, [codexLogin.data, activeProjectId, activeSessionId, queryClient]);

	const pageRestores = usePageRestores();
	// A stream the browser gave up on (a deploy answered a reconnect with an
	// error) is reopened here with backoff, without telling the user.
	const [progressReopens, setProgressReopens] = useState(0);
	const progressReopenAttempt = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a page back from the back/forward cache, or a reopen after the browser gave up, reopens the stream.
	useEffect(() => {
		if (!activeProjectId || !activeSessionId || !listenForProgress) return;
		const epoch = sessionEpoch.current;
		const source = new EventSource(
			`/api/agent/progress?${new URLSearchParams({ projectId: activeProjectId, sessionId: activeSessionId })}`,
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
			// A snapshot holds the chat's last turns; older ones shown stay above.
			const page = progressPage(progress);
			const shown = (current: PublicCodexSession) =>
				withEarlierPages(current, {
					agentSessionId: activeSessionId,
					...page,
				});
			const incoming = shown(currentSessionRef.current);
			if (!progressMatchesTurn(currentSessionRef.current.items, incoming.items))
				return;
			if (
				progressRevivesStoppedTurn({
					stopRequested: stopRequestedFor.current === activeSessionId,
					current: currentSessionRef.current.items,
					next: incoming.items,
					nextStatus: progress.turnStatus,
				})
			)
				return;
			lastRevision = event.lastEventId;
			liveProgress.current = {
				sessionId: activeSessionId,
				receivedAt: Date.now(),
			};
			setSession((current) => {
				const next = shown(current);
				return progressMatchesTurn(current.items, next.items)
					? {
							...current,
							items: next.items,
							hasOlderItems: next.hasOlderItems,
							turnStatus: progress.turnStatus,
							usage: progress.usage ?? current.usage,
						}
					: current;
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
		let reopenTimer: ReturnType<typeof setTimeout> | undefined;
		source.onopen = () => {
			progressStreamOpen.current = activeSessionId;
			progressReopenAttempt.current = 0;
		};
		source.onerror = () => {
			liveProgress.current = null;
			// Polling stands in until the stream reconnects.
			if (progressStreamOpen.current === activeSessionId) {
				progressStreamOpen.current = null;
				refetchOpenSession.current();
			}
			// The browser retries by itself unless the reconnect was refused.
			if (source.readyState === EventSource.CLOSED && !reopenTimer) {
				const attempt = progressReopenAttempt.current++;
				reopenTimer = setTimeout(
					() => setProgressReopens((count) => count + 1),
					progressReopenDelayMs(attempt),
				);
			}
		};
		return closeOnPageHide(() => {
			clearTimeout(reopenTimer);
			source.close();
			liveProgress.current = null;
			if (progressStreamOpen.current === activeSessionId)
				progressStreamOpen.current = null;
		});
	}, [
		activeProjectId,
		activeSessionId,
		listenForProgress,
		harnessId,
		pageRestores,
		progressReopens,
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

	// An import started in onboarding or Settings that finishes meanwhile.
	useImportFinishAlert();
	useTurnFinishAlerts(
		sidebarChats.map((chat) => ({
			id: chat.id,
			title: chat.title,
			running: sidebarChatIsRunning({
				chatId: chat.id,
				turnStatus: chat.turnStatus,
				busyChatIds,
				openChatId: activeSessionId,
				openTurnStatus,
			}),
			turnStatus:
				chat.id === activeSessionId ? openTurnStatus : chat.turnStatus,
			waitingOn: chat.waitingOn,
		})),
		openChat,
	);

	// The open project's environment; WorkspaceStatus polls it while it is set up.
	const projectSetup = useQuery({
		...workspaceStatusQuery(selectedProject?.id ?? ""),
		enabled: Boolean(selectedProject?.id),
	});
	const projectSetupStatus = projectSetup.data?.status;
	// A new project's setup runs in its own chat, started by the server
	// (project-setup-background.ts); the person's chat says it need not wait.
	const setupState = {
		workspace:
			projectSetup.data?.projectId === selectedProject?.id
				? projectSetup.data
				: null,
		setupChat: projectSetupChat(chats.data),
		openChatId: activeSessionId,
	};
	const setupPlaceholder = setupComposerPlaceholder(setupState);
	const setupLine = setupIndicator(setupState);
	const setupLineChatId = setupLine?.chatId;
	const setupIndicatorShown =
		setupLine && selectedProject
			? {
					projectId: selectedProject.id,
					kind: setupLine.kind,
					text: setupLine.text,
					action: setupLine.action,
					...(setupLineChatId
						? { onOpen: () => openChat(setupLineChatId) }
						: {}),
				}
			: null;
	setupChatIdRef.current = setupState.setupChat?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs as the setup status changes; the held send carries its own scope.
	useEffect(() => {
		const held = heldForSetupRef.current;
		if (!held) return;
		// Another project's status says nothing about this message.
		if (held.scope.projectId !== selectedProject?.id) return;
		// Held only while the project had no environment record: a task goes
		// once there is one; the setup request waits for the environment (a
		// failed setup keeps it held with its actions).
		if (!heldSendReleases(projectSetupStatus, held)) return;
		heldForSetupRef.current = null;
		setHeldForSetup(new Set());
		setHeldMessage(null);
		if (session.connection.status === "authenticated")
			void deliverSend(
				held,
				held.startsNewChat ? { ...session, agentSessionId: null } : session,
			);
		else void connectThenSend(held);
	}, [projectSetupStatus, selectedProject?.id]);

	// The setup a turn saved (save_project_environment) shows without a reload.
	const previousTurnStatus = useRef(session.turnStatus);
	useEffect(() => {
		const was = previousTurnStatus.current;
		previousTurnStatus.current = session.turnStatus;
		if (was !== "running" || session.turnStatus === "running") return;
		const projectId = selectedProject?.id;
		if (!projectId) return;
		void queryClient.invalidateQueries({
			queryKey: workspaceStatusQuery(projectId).queryKey,
		});
		void queryClient.invalidateQueries({
			queryKey: environmentQueryKey(projectId),
		});
	}, [queryClient, selectedProject?.id, session.turnStatus]);

	const heldSetup = useMutation({
		mutationFn: (mode: WorkspaceRetryMode) => {
			const workspaceId = projectSetup.data?.id;
			if (!workspaceId) throw new Error("The project is still loading.");
			return retryWorkspace({ workspaceId, mode });
		},
		onSuccess: () => {
			const projectId = selectedProject?.id;
			if (!projectId) return;
			void projectSetup.refetch();
			void queryClient.invalidateQueries({
				queryKey: environmentProgressQuery(projectId).queryKey,
			});
		},
		onError: (cause) => toast.error(publicFailureMessage(cause)),
	});
	/** Takes back a message still waiting in the open chat (queued, or held for setup). */
	function removeQueuedMessage(messageId: string) {
		const epoch = sessionEpoch.current;
		const index = session.items.findIndex((item) => item.id === messageId);
		const removed = session.items[index];
		setSession((current) => ({
			...current,
			items: current.items.filter((item) => item.id !== messageId),
		}));
		void removeQueued({
			data: { ...sessionScope(), messageId },
		})
			.then((next) => applySessionView(epoch, next))
			.catch((cause) => {
				toast.error(publicFailureMessage(cause));
				// Put the queued message back where it was, in the same chat.
				if (!removed || epoch !== sessionEpoch.current) return;
				setSession((current) =>
					current.items.some((item) => item.id === messageId)
						? current
						: {
								...current,
								items: [
									...current.items.slice(0, index),
									removed,
									...current.items.slice(index),
								],
							},
				);
			});
	}

	/** Rewrites a waiting message; `environmentSetup` makes a held one a setup chat's request. */
	function editQueuedMessage(
		messageId: string,
		text: string,
		environmentSetup = false,
	) {
		const epoch = sessionEpoch.current;
		const previous = session.items.find((item) => item.id === messageId);
		setSession((current) => ({
			...current,
			items: current.items.map((item) =>
				item.kind === "userMessage" && item.id === messageId
					? { ...item, text }
					: item,
			),
		}));
		return updateQueued({
			data: {
				...sessionScope(),
				messageId,
				text,
				...(environmentSetup ? { environmentSetup: true } : {}),
			},
		})
			.then((next) => applySessionView(epoch, next))
			.catch((cause) => {
				toast.error(publicFailureMessage(cause));
				if (!previous || epoch !== sessionEpoch.current) return;
				setSession((current) => ({
					...current,
					items: current.items.map((item) =>
						item.id === messageId ? previous : item,
					),
				}));
			});
	}

	// The open chat's message held for setup, as the server stores it: it
	// shows after a reload and on every device, and goes by itself once the
	// environment is ready (the server sends it, tab open or not).
	const storedHeld = heldForSetupMessage(session.items);
	// The project whose setup the open chat shows in place (its banner steps aside).
	const storedHeldProjectId =
		storedHeld && selectedProject ? selectedProject.id : null;
	// A new project's empty chat is the person's: the setup runs in its own
	// chat in the background (one line beside the composer), never here.
	const heldProjects = useMemo(
		() =>
			storedHeldProjectId
				? new Set([...heldForSetup, storedHeldProjectId])
				: heldForSetup,
		[heldForSetup, storedHeldProjectId],
	);
	// The server sends a held message once the environment is ready, a few
	// seconds after this tab may see it ready: the open chat is read until the
	// message's turn shows (sessionRead polls while awaitingHeldDelivery).
	const storedHeldId = storedHeld?.id;
	useEffect(() => {
		if (
			!storedHeldId ||
			!activeSessionId ||
			!heldSendReleases(projectSetupStatus)
		)
			return;
		setAwaitedHeld((current) =>
			current?.messageId === storedHeldId && current.chatId === activeSessionId
				? current
				: {
						chatId: activeSessionId,
						messageId: storedHeldId,
						since: Date.now(),
					},
		);
	}, [activeSessionId, projectSetupStatus, storedHeldId]);
	// Its turn showed (the sidebar's clock goes too), the chat changed, or it
	// never came: the last read then shows the chat as the server has it.
	const heldArrived = awaitedHeld
		? messageDelivered(session.items, awaitedHeld.messageId)
		: false;
	useEffect(() => {
		if (!awaitedHeld) return;
		const finish = () => {
			setAwaitedHeld(null);
			void queryClient.invalidateQueries({ queryKey: ["agent-sessions"] });
		};
		if (heldArrived || awaitedHeld.chatId !== activeSessionId) {
			finish();
			return;
		}
		const timer = window.setTimeout(
			() => {
				finish();
				refetchOpenSession.current();
			},
			Math.max(0, awaitedHeld.since + HELD_DELIVERY_WATCH_MS - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [activeSessionId, awaitedHeld, heldArrived, queryClient]);
	/** "Fix with the agent": the held message becomes a setup chat's request. */
	function setUpHeldWithAgent() {
		if (storedHeld) {
			const text = setupRequestKeeping(storedHeld.text);
			void editQueuedMessage(storedHeld.id, text, true).then(() =>
				heldSetup.mutate("plain"),
			);
			return;
		}
		const held = heldForSetupRef.current;
		if (!held?.startsNewChat) return;
		const text = setupRequestKeeping(held.text);
		heldForSetupRef.current = { ...held, text, environmentSetup: true };
		setHeldMessage((current) => (current ? { ...current, text } : current));
		heldSetup.mutate("plain");
	}
	const heldView =
		heldMessage && heldMessage.projectId === selectedProject?.id
			? { ...heldMessage, stored: false }
			: storedHeld && selectedProject
				? {
						projectId: selectedProject.id,
						messageId: storedHeld.id,
						text: storedHeld.text,
						// Its chat's first message: nothing but waiting messages in it.
						startsNewChat: session.items.every(
							(item) => item.kind === "userMessage" && item.queued,
						),
						stored: true,
					}
				: null;
	const heldFailed =
		projectSetupStatus === "failed" ||
		Boolean(
			projectSetup.data &&
				workspacePrepareStalled(projectSetup.data, Date.now()),
		);

	function openInspector(view: ToolsView) {
		if (
			view === "files" ||
			view === "diff" ||
			view === "terminal" ||
			view === "desktop"
		)
			captureAnalytics("inspector_opened", { panel: view });
		// Timed only when the view actually opens (web-vitals.ts).
		if (inspectorView !== view || !inspectorOpen) {
			if (view === "files") startInteraction("files_open");
			if (view === "terminal") startInteraction("terminal_ready");
		}
		setInspectorView(view);
		setInspectorOpen(true);
	}

	/**
	 * The pointer or focus reached a workspace view: Files reads its tree and
	 * first file, Memory its files; Terminal and Desktop wake the
	 * chat's machine (if it has one; never creating one) so they connect
	 * without that wait.
	 */
	function intendView(view: ToolsView) {
		if (view === "pr") {
			prefetchChatPullRequest();
			return;
		}
		const projectId = selectedProject?.id;
		const sessionId = activeSessionId;
		if (!projectId || !sessionId) return;
		if (view === "memory") {
			prefetchMemoryPage(queryClient);
			return;
		}
		if (view === "files") {
			void prefetchWorkspaceFiles(queryClient, {
				projectId,
				sessionId,
				changes: fileChanges,
			});
			return;
		}
		if (view !== "terminal" && view !== "desktop") return;
		wakeChatMachine(projectId, sessionId);
	}

	/**
	 * Starts a chat's machine if it has one and it sleeps (a paused machine
	 * resumes in about 0.3 s, then answers its first command), at most once a
	 * minute per chat. Never creates one.
	 */
	function wakeChatMachine(projectId: string, sessionId: string) {
		const asked = resumedMachines.current.get(sessionId) ?? 0;
		if (Date.now() - asked < MACHINE_RESUME_INTERVAL_MS) return;
		resumedMachines.current.set(sessionId, Date.now());
		void resumeMachine({ data: { projectId, sessionId } }).catch(
			() => undefined,
		);
	}

	const intendViewRef = useRef(intendView);
	intendViewRef.current = intendView;
	// An open inspector is a click from Files: read its tree ahead.
	useEffect(() => {
		if (!inspectorOpen || !activeProjectId || !activeSessionId) return;
		const timer = window.setTimeout(
			() => intendViewRef.current("files"),
			FILES_READ_AHEAD_MS,
		);
		return () => window.clearTimeout(timer);
	}, [inspectorOpen, activeProjectId, activeSessionId]);

	function openMentionedFile(path: string) {
		setSelectedFilePath(path);
		openInspector("files");
	}

	/** Opening another project leaves nothing of the previous project's chat on screen. */
	function selectProject(projectId: string) {
		setMemoryPageOpen(false);
		if (projectId === selectedProject?.id) return;
		setSelectedProjectId(projectId);
		// The project change below is this one: it keeps the chat opened here.
		chatsProjectId.current = projectId;
		bumpSessionEpoch();
		pendingNewChatRef.current = false;
		setInspectorView("overview");
		setSelectedFilePath(undefined);
		setDesktop({ status: "stopped" });
		// The project's latest chat opens now, from the view the page holds or
		// the browser's copy, like a clicked chat; not after its list re-reads.
		const listed =
			queryClient.getQueryData<readonly SidebarChat[]>([
				"agent-sessions",
				projectId,
			]) ?? [];
		const latest = chatOpenedWithProject({
			chats: listed,
			composerDraft: composerDraftRef.current,
		})?.id;
		selectedSessionIdRef.current = latest;
		setSelectedSessionId(latest);
		setSession((current) => sessionWithoutOpenChat(current));
		if (latest) showChatView(latest, listed);
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
			canSend: false,
		}));
		setComposerDraft(true);
		setProjectPickerOpen(true);
		if (compact) setProjectsOpen(false);
	}

	/**
	 * Rerun setup (the person asked for it): a new chat in that project that
	 * sends the setup request by itself and opens, so they watch it. A new
	 * project's first setup never comes here: it starts in the background
	 * (startsBackgroundProjectSetup).
	 */
	function startProjectSetup(projectId: string) {
		setSettingsOpen(false);
		startNewChat(projectId);
		environmentSetupEpochRef.current = sessionEpoch.current;
		setComposerPrefill({
			text: ENVIRONMENT_SETUP_PROMPT,
			at: Date.now(),
			send: true,
		});
	}

	function startNewChat(projectId?: string) {
		setMemoryPageOpen(false);
		const targetProjectId = projectId ?? selectedProject?.id;
		if (!targetProjectId) {
			openAddProject();
			return;
		}
		if (projectId) setSelectedProjectId(projectId);
		const newChatHarnessId = harnessId;
		setHarnessId(newChatHarnessId);
		setComposerDraft(false);
		setProjectPickerOpen(false);
		const epoch = bumpSessionEpoch();
		// Until the new chat exists, polls and sends must not reach the old one.
		creatingChatEpoch.current = epoch;
		selectedSessionIdRef.current = undefined;
		setSelectedSessionId(undefined);
		setSession((current) => ({
			...current,
			agentSessionId: null,
			selectedBranch: undefined,
			listedModelId: "",
			models: [],
			items: [],
			turnStatus: "idle",
			connection: { status: "disconnected" },
			canSend: false,
		}));
		void startSession({
			data: { projectId: targetProjectId, harnessId: newChatHarnessId },
		})
			.then((created) => {
				if (epoch !== sessionEpoch.current) return;
				creatingChatEpoch.current = null;
				createdChatId.current = created.id;
				selectedSessionIdRef.current = created.id;
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
					connection: { status: "disconnected" },
					canSend: false,
				}));
				void chats.refetch();
			})
			.catch((cause) => {
				if (epoch !== sessionEpoch.current) return;
				creatingChatEpoch.current = null;
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: newChatHarnessId,
						message: publicFailureMessage(cause),
					},
					canSend: false,
				}));
			});
	}

	/**
	 * Typing in an empty new chat copies its machine while the message is
	 * written; typing a follow-up in a chat whose machine sleeps wakes it, so
	 * the turn finds it running. Typing, not opening: a chat opened only to
	 * read must not start its machine (vCPU is billed while it runs).
	 */
	function prewarmOpenChat() {
		const chatId = session.agentSessionId;
		const projectId = selectedProject?.id;
		if (!chatId || !projectId || session.turnStatus === "running") return;
		if (session.items.length) {
			wakeChatMachine(projectId, chatId);
			return;
		}
		if (prewarmedChats.current.has(chatId)) return;
		prewarmedChats.current.add(chatId);
		void prewarmSession({ data: { projectId, sessionId: chatId } }).catch(
			() => undefined,
		);
	}

	function deleteChat(chatId: string) {
		if (!selectedProject) {
			return;
		}
		removeChat.mutate({ projectId: selectedProject.id, sessionId: chatId });
		sessionViews.current.delete(chatId);
		void chatCache?.forget([chatId]);
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
				connection: { status: "disconnected" },
				canSend: false,
			}));
		}
	}

	function removeProject(projectId: string) {
		const listed = projects.data ?? [];
		const nextId = selectedProjectIdAfterDelete({
			projects: listed,
			selectedProjectId: selectedProject?.id,
			deletedProjectId: projectId,
		});
		removeOwnedProject.mutate(projectId);
		queryClient.removeQueries({ queryKey: ["agent-sessions", projectId] });
		void chatCache?.keepOnly(projectId, []);
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
				connection: { status: "disconnected" },
				canSend: false,
			}));
		}
	}

	async function signOut() {
		await clearChatCache();
		await authClient.signOut();
		window.location.assign("/");
	}

	function openChat(id: string) {
		startInteraction("chat_switch");
		setMemoryPageOpen(false);
		setComposerDraft(false);
		setProjectPickerOpen(false);
		selectedSessionIdRef.current = id;
		bumpSessionEpoch();
		setSelectedSessionId(id);
		setInspectorView("overview");
		setSelectedFilePath(undefined);
		setDesktop({ status: "stopped" });
		showChatView(
			id,
			projectChats.find((group) => group.chats.some((chat) => chat.id === id))
				?.chats ?? sidebarChats,
		);
	}

	/**
	 * Puts an opened chat on screen at once: the view the page holds, else
	 * an empty view the browser's cached copy fills; the open chat's server
	 * read (sessionRead) then replaces either. The epoch was bumped already.
	 */
	function showChatView(id: string, listed: readonly SidebarChat[]) {
		const cached = sessionViews.current.get(id);
		setHarnessId(
			composerHarnessForChat({
				listedHarnessId: listed.find((chat) => chat.id === id)?.harnessId,
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
		const listedTurn = listedChatTurnStatus(listed, id);
		const listedModelId = listedChatModelId(listed, id);
		setSession((current) => ({
			...current,
			agentSessionId: id,
			selectedBranch: undefined,
			listedModelId: listedModelId || current.listedModelId,
			items: [],
			turnStatus: listedTurn,
			connection: { status: "disconnected" },
			canSend: false,
		}));
		showCachedChat(id);
	}

	/**
	 * Shows the browser's copy of a chat opened without a held view, until
	 * the server's read (already under way) replaces it. A copy that lands
	 * after the server's view, or after another open, is dropped.
	 */
	function showCachedChat(id: string) {
		const epoch = sessionEpoch.current;
		void chatCache?.read(id).then((view) => {
			if (
				!view ||
				epoch !== sessionEpoch.current ||
				serverViewEpoch.current === epoch ||
				selectedSessionIdRef.current !== id ||
				composerDraftRef.current
			)
				return;
			setSession((current) =>
				current.agentSessionId === id && current.items.length === 0
					? view
					: current,
			);
		});
	}

	/** A hovered chat's cached copy, held so opening it shows at once. */
	function holdCachedChat(chatId: string) {
		void chatCache?.read(chatId).then((view) => {
			if (!view || sessionViews.current.has(chatId)) return;
			sessionViews.current.set(chatId, view);
			restoredChats.current.add(chatId);
		});
	}

	/** The open chat's older turns being read, by the oldest item shown then. */
	const olderRead = useRef<string | null>(null);
	/** When reading older turns last failed: the next try waits a little. */
	const olderFailedAt = useRef(0);
	const [olderLoading, setOlderLoading] = useState(false);
	/**
	 * Reads the turns before the oldest one shown and puts them above it. A
	 * chat whose transcript no longer holds that item (a restore rewrote it)
	 * is read again instead.
	 */
	function loadOlderItems() {
		const view = currentSessionRef.current;
		const chatId = view.agentSessionId;
		const before = view.items[0]?.id;
		const projectId = activeProjectId;
		if (!view.hasOlderItems || !chatId || !before || !projectId) return;
		if (olderRead.current) return;
		if (Date.now() - olderFailedAt.current < OLDER_RETRY_MS) return;
		olderRead.current = before;
		setOlderLoading(true);
		const epoch = sessionEpoch.current;
		const settle = () => {
			olderRead.current = null;
			setOlderLoading(false);
		};
		void getOlderSessionItems({
			data: { projectId, sessionId: chatId, before },
		})
			.then(async (page) => {
				if (epoch !== sessionEpoch.current) return;
				if (!page.found) {
					const fresh = await getCodexSession({
						data: { projectId, sessionId: chatId, harnessId },
					});
					if (epoch !== sessionEpoch.current) return;
					sessionViews.current.set(chatId, fresh);
					chatCache?.write(projectId, fresh);
					setSession((current) =>
						current.agentSessionId === chatId ? fresh : current,
					);
					return;
				}
				const older = { ...page, chatId, beforeId: before };
				const cached = sessionViews.current.get(chatId);
				if (cached)
					sessionViews.current.set(chatId, withOlderPage(cached, older));
				setSession((current) => withOlderPage(current, older));
			})
			// A failed read is tried again once the reader scrolls after a pause.
			.catch(() => {
				olderFailedAt.current = Date.now();
			})
			.finally(settle);
	}

	/**
	 * Reads a chat's view before it is opened (on hover, or the open project's
	 * latest chats once the page is idle), so opening it shows the transcript
	 * at once; the open reads it again. Never replaces a view the page holds.
	 */
	function readAheadChat(chatId: string) {
		if (
			(sessionViews.current.has(chatId) &&
				!restoredChats.current.has(chatId)) ||
			viewReads.current.has(chatId)
		)
			return;
		const listed = projectChats.find((group) =>
			group.chats.some((chat) => chat.id === chatId),
		);
		if (!listed) return;
		holdCachedChat(chatId);
		const read = getCodexSession({
			data: {
				projectId: listed.project.id,
				sessionId: chatId,
				harnessId: listedChatHarnessId(listed.chats, chatId, harnessId),
			},
		})
			.then((view) => {
				if (view.agentSessionId !== chatId) {
					void chatCache?.forget([chatId]);
					return null;
				}
				if (
					!sessionViews.current.has(chatId) ||
					restoredChats.current.has(chatId)
				) {
					sessionViews.current.set(chatId, view);
					restoredChats.current.delete(chatId);
				}
				chatCache?.write(listed.project.id, view);
				return view;
			})
			.catch(() => null)
			.finally(() => viewReads.current.delete(chatId));
		viewReads.current.set(chatId, read);
	}
	const readAheadRef = useRef(readAheadChat);
	readAheadRef.current = readAheadChat;

	/** The send did not go out: take its message back, unlock the turn, say why. */
	function abandonSend(pending: PendingSend, message: string | null) {
		if (pendingSendRef.current === pending) pendingSendRef.current = null;
		if (message) toast.error(message);
		// Keyed by the message id, so it only touches a view that still shows
		// this send: its "Thinking" never outlives the send, even if the chat
		// was reselected meanwhile.
		setSession((current) =>
			sessionWithoutFailedSend(
				current,
				pending.messageId,
				pending.previousTurnStatus,
			),
		);
		if (pending.epoch === sessionEpoch.current) {
			// A first message that made no chat returns to the new-chat draft.
			if (pending.startsNewChat && !selectedSessionIdRef.current) {
				pendingNewChatRef.current = false;
				composerDraftRef.current = true;
				setComposerDraft(true);
			}
		}
		pending.settle(unsentResult(pending.epoch, pending.chatId));
	}
	abandonSendRef.current = abandonSend;

	function unsentResult(
		sentEpoch: number,
		sentChatId: string | undefined,
	): ComposerSendResult {
		return unsentSendReturnsHere({
			sentEpoch,
			currentEpoch: sessionEpoch.current,
			sentChatId,
			openChatId: selectedSessionIdRef.current,
		})
			? "unsent"
			: "unsentElsewhere";
	}

	/**
	 * A send that errored may still have landed (the reply was lost, or reading
	 * the chat back failed after the message was stored). Ask the server before
	 * taking the message back; if it holds the message, keep following the turn.
	 */
	async function sendLanded(pending: PendingSend, view: PublicCodexSession) {
		const sessionId = pending.scope.sessionId ?? view.agentSessionId;
		if (!pending.scope.projectId) return false;
		try {
			// A new chat's first send has no chat id yet: the server finds the
			// chat that queued this message id, if any.
			const landed = await withinTimeout(
				getCodexSession({
					data: {
						projectId: pending.scope.projectId,
						harnessId: pending.scope.harnessId,
						...(sessionId
							? { sessionId }
							: { userMessageId: pending.messageId }),
					},
				}),
				SEND_TIMEOUT_MS,
				SEND_TIMEOUT_MESSAGE,
			);
			if (
				!landed?.connection ||
				!sendWasQueued(landed.items, pending.messageId)
			)
				return false;
			applySessionView(pending.epoch, landed);
			return true;
		} catch {
			return false;
		}
	}

	/** The transcript with the sent message at its end (once, by message id). */
	function itemsWithSentMessage(
		items: PublicCodexSession["items"],
		pending: PendingSend,
	) {
		return sessionItemsQueuedWithUser(
			items,
			pending.text,
			pending.messageId,
			pending.approvesPlan,
			pending.attachments?.map((file) => {
				const id = crypto.randomUUID();
				return {
					id,
					name: safeAttachmentName(file.name),
					mediaType: file.mediaType,
					size: base64ByteLength(file.base64),
					...sentPasteFields(id, file),
				};
			}),
		);
	}

	async function deliverSend(pending: PendingSend, view: PublicCodexSession) {
		if (pendingSendRef.current === pending) pendingSendRef.current = null;
		const { epoch, scope, chatId } = pending;
		setBusyChatIds((ids) => withBusyChat(ids, chatId));
		let requested = false;
		try {
			const resolvedModel =
				pending.modelId ||
				preferredSessionModelId(sessionModelsFromListed(view.models), {
					lastUsedId: view.listedModelId,
					excludedIds: view.blockedListedModelIds,
				});
			if (!resolvedModel) throw new Error("Select a model before sending.");
			if (epoch === sessionEpoch.current && pending.heldForSetup) {
				// Shown held at once; no turn starts until the environment is ready.
				setSession((current) => ({
					...current,
					items: itemsWithSentMessage(current.items, pending).map((item) =>
						item.kind === "userMessage" && item.id === pending.messageId
							? { ...item, queued: true as const, heldForSetup: true as const }
							: item,
					),
				}));
			} else if (epoch === sessionEpoch.current) {
				stopRequestedFor.current = null;
				setStoppingChatId(null);
				setSession((current) => {
					const items = itemsWithSentMessage(current.items, pending);
					return {
						...current,
						turnStatus: "running",
						// Sent during a run, it waits for the run's next step.
						items:
							current.turnStatus === "running"
								? markedQueuedSend(items, pending.messageId)
								: items,
					};
				});
			}
			if (scope.projectId && chatId) {
				queryClient.setQueryData(
					["agent-sessions", scope.projectId],
					(current: readonly SidebarChat[] | undefined) =>
						pending.heldForSetup
							? withChatHeldForSetup(current ?? [], chatId, pending.text)
							: withChatSent(current ?? [], chatId, pending.text),
				);
			}
			requested = true;
			// A send that hangs is reported (and checked for having landed)
			// instead of leaving the message showing as sent.
			const next = await withinTimeout(
				sendTask({
					data: {
						...scope,
						sessionId: scope.sessionId ?? view.agentSessionId ?? undefined,
						text: pending.text,
						modelId: resolvedModel,
						userMessageId: pending.messageId,
						...(pending.variant ? { variant: pending.variant } : {}),
						...(pending.speed
							? { speed: pending.speed, fast: pending.speed === "fast" }
							: {}),
						...(pending.alternateContext !== undefined
							? { alternateContext: pending.alternateContext }
							: {}),
						...(pending.approvesPlan ? { approvesPlan: true } : {}),
						...(pending.continueOn ? { continueOn: pending.continueOn } : {}),
						...(pending.attachments?.length
							? { attachments: [...pending.attachments] }
							: {}),
						...(pending.baseBranch ? { baseBranch: pending.baseBranch } : {}),
						...(pending.environmentSetup ? { environmentSetup: true } : {}),
					},
				}),
				SEND_TIMEOUT_MS,
				SEND_TIMEOUT_MESSAGE,
			);
			// A reply that holds neither the message nor a running turn means
			// no turn is behind the "Thinking": report it, never leave it.
			const outcome = sendReplyOutcome(next, pending.messageId);
			if (outcome.kind === "failed") throw new Error(outcome.message);
			if (outcome.kind === "await_sign_in") {
				// The saved sign-in was gone: show the code, send once it is entered.
				if (epoch === sessionEpoch.current)
					setSession((current) => ({
						...sessionWithoutFailedSend(
							current,
							pending.messageId,
							pending.previousTurnStatus,
						),
						connection: next.connection,
					}));
				pendingSendRef.current = pending;
				return;
			}
			applySessionView(epoch, next);
			pending.settle("sent");
		} catch (cause) {
			if (requested && (await sendLanded(pending, view))) {
				pending.settle("sent");
				return;
			}
			abandonSend(pending, publicFailureMessage(cause));
		} finally {
			setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
			void chats.refetch();
		}
	}
	deliverSendRef.current = deliverSend;

	/** Sign in or connect first; a ChatGPT device code holds the message until it is entered. */
	async function connectThenSend(pending: PendingSend) {
		const { epoch, chatId } = pending;
		setBusyChatIds((ids) => withBusyChat(ids, chatId));
		// The message shows while the chat connects (its machine may be waking);
		// the connected view replaces it, and the send adds it back as sent.
		if (epoch === sessionEpoch.current)
			setSession((current) => ({
				...current,
				items: itemsWithSentMessage(current.items, pending),
			}));
		let next: PublicCodexSession;
		try {
			// A connect that hangs returns the message instead of holding it.
			next = await withinTimeout(
				connect({ data: pending.scope }),
				SEND_TIMEOUT_MS,
				SEND_TIMEOUT_MESSAGE,
			);
			if (!next?.connection) throw new Error("Could not connect. Retry.");
		} catch (cause) {
			if (epoch === sessionEpoch.current)
				setSession((current) => ({
					...current,
					connection: {
						status: "failed",
						provider: pending.scope.harnessId,
						message: publicFailureMessage(cause),
					},
				}));
			abandonSend(pending, null);
			return;
		} finally {
			setBusyChatIds((ids) => withoutBusyChat(ids, chatId));
		}
		// Nothing is marked running yet, so the connect view (and its code) shows.
		applySessionView(epoch, next);
		const step = sendAfterConnect(next.connection);
		if (step === "await_sign_in") {
			pendingSendRef.current = pending;
			return;
		}
		if (step === "abandon") {
			// The composer names the block once it reads this view; a send that
			// raced ahead of it still says why it did not go.
			const block = composerSendBlock({
				harnessId: pending.scope.harnessId,
				blockers: next.sendBlockers,
				modelId: pending.modelId,
				availableModelIds: next.models.map((model) => model.id),
			});
			abandonSend(pending, block?.message ?? null);
			return;
		}
		await deliverSend(pending, next);
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
	// Until the live list is read, the header shows the PR this browser saw
	// last for the chat (the sidebar's saved PR), so it does not pop in.
	const savedChatPr =
		!pullRequestsRead &&
		(activeChat?.pr?.state === "open" || activeChat?.pr?.state === "draft")
			? activeChat.pr
			: null;
	const sessionPullRequest = sessionPullRequests[0];
	// The Overview's PR row likewise stands in from the saved PR until the live
	// list is read; readiness the save does not hold reads as not confirmed.
	const overviewPullRequests: readonly ListedPullRequest[] =
		pullRequestsRead || !activeChat?.pr || !activeHead
			? sessionPullRequests
			: [savedListedPullRequest(activeChat.pr, activeHead)];
	// The handoff's link stands in until the PR list has read it.
	const handedOffPullRequest =
		pullRequestHandoff?.state === "opened"
			? {
					number: pullRequestHandoff.number,
					url: pullRequestHandoff.url,
					draft: pullRequestHandoff.draft,
				}
			: undefined;
	const headerPullRequest =
		sessionPullRequest ??
		handedOffPullRequest ??
		(savedChatPr
			? {
					number: savedChatPr.number,
					url: savedChatPr.url,
					draft: savedChatPr.state === "draft",
				}
			: undefined);
	const headerOpeningPullRequest =
		!headerPullRequest && pullRequestHandoff?.state === "opening";
	function connectHarness() {
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
	}

	/** A memory's source chat, opened in its project; false when it is not listed. */
	function openMemoryChat(chatId: string) {
		const listed = projectChats.find((group) =>
			group.chats.some((chat) => chat.id === chatId),
		);
		if (!listed) return false;
		selectProject(listed.project.id);
		openChat(chatId);
		return true;
	}

	const [paletteOpen, setPaletteOpen] = useState(false);
	const [shortcutsOpen, setShortcutsOpen] = useState(false);
	const inspectorShortcutHint = useShortcutHint("toggleInspector");
	const chatPullRequestRepository = pullRequestPanelRepository({
		repositories: projectRepositories,
		chatPullRequest: sessionPullRequest,
	});
	/** Reads the chat's pull request ahead of its panel, so opening it is instant. */
	function prefetchChatPullRequest() {
		const pull = chatPullRequestRepository;
		if (pull?.number === undefined) return;
		prefetchPullRequestDetail(queryClient, { ...pull, number: pull.number });
	}
	const prefetchChatPullRequestRef = useRef(prefetchChatPullRequest);
	prefetchChatPullRequestRef.current = prefetchChatPullRequest;
	// The Overview's pull request card is a click from the panel: read it ahead.
	const overviewPullRequestKey =
		inspectorOpen && inspectorView === "overview"
			? sessionPullRequest &&
				`${sessionPullRequest.repositoryId}:${sessionPullRequest.number}`
			: undefined;
	useEffect(() => {
		if (overviewPullRequestKey) prefetchChatPullRequestRef.current();
	}, [overviewPullRequestKey]);

	function openSettings() {
		setSettingsSection(undefined);
		setSettingsOpen(true);
	}

	/** Opens the view, or closes the panel when it already shows it (VS Code's Ctrl+`). */
	function toggleInspectorView(view: ToolsView) {
		if (inspectorOpen && inspectorView === view) toggleInspectorPanel();
		else openInspector(view);
	}

	function openSidebarChat(chatId: string | undefined) {
		if (chatId && chatId !== activeSessionId) openMemoryChat(chatId);
	}

	function stopOpenTurn() {
		const chatId = activeSessionId;
		const epoch = sessionEpoch.current;
		// The stopped turn ends idle; accept that view even if the
		// live progress stream never reports the stop, and ignore the
		// running views sent before the stop settled.
		stopRequestedFor.current = chatId ?? null;
		setStoppingChatId(chatId ?? null);
		// Stopped on click: the composer is free at once, the partial answer
		// stays with its "Stopped" notice. The server's settled view replaces
		// these items when it arrives.
		setSession((current) =>
			current.agentSessionId && current.agentSessionId !== chatId
				? current
				: sessionStoppedByUser(current, Date.now()),
		);
		// The turn settles on the server after this answers; keep
		// listening so its settled transcript shows without a reload.
		if (chatId) setWakeWatch({ sessionId: chatId, since: Date.now() });
		void stopTurn({
			data: sessionScope(),
		})
			.then((next) => applySessionView(epoch, next))
			.catch((cause) => {
				// The stop never reached the server: show the chat as it is.
				if (stopRequestedFor.current === chatId)
					stopRequestedFor.current = null;
				toast.error(publicFailureMessage(cause));
				refetchOpenSession.current();
			})
			.finally(() => {
				setStoppingChatId((id) => (id === chatId ? null : id));
				void chats.refetch();
			});
	}

	function copyLastReply() {
		const text = lastAgentMessageText(session.items);
		if (!text) return;
		navigator.clipboard.writeText(text).then(
			() => toast.success("Copied the last reply."),
			() => toast.error("Couldn't copy to the clipboard."),
		);
	}

	const turnRunning = session.turnStatus === "running";
	useGlobalShortcuts({
		commandPalette: () => setPaletteOpen((open) => !open),
		shortcuts: () => setShortcutsOpen((open) => !open),
		openSettings,
		toggleSidebar: () => setProjectsOpen((open) => !open),
		toggleInspector: () => toggleInspectorPanel(),
		toggleTerminal: () => toggleInspectorView("terminal"),
		toggleDesktop: () => toggleInspectorView("desktop"),
		openPullRequest: () => {
			if (chatPullRequestRepository) openInspector("pr");
		},
		newChat: () => startNewChat(),
		previousChat: () =>
			openSidebarChat(
				adjacentChatId(sidebarChatIdsInOrder(), activeSessionId, -1),
			),
		nextChat: () =>
			openSidebarChat(
				adjacentChatId(sidebarChatIdsInOrder(), activeSessionId, 1),
			),
		jumpToChat: (index) => openSidebarChat(sidebarChatIdsInOrder()[index]),
		copyLastReply,
		focusComposer: () => document.getElementById(COMPOSER_INPUT_ID)?.focus(),
		modelPicker: () => document.getElementById(MODEL_PICKER_ID)?.click(),
		stop: () => {
			if (turnRunning) stopOpenTurn();
		},
	});

	const paletteItems: CommandPaletteItem[] = [
		{
			id: "new-chat",
			group: "Actions",
			label: "New chat",
			shortcut: "newChat",
			run: () => startNewChat(),
		},
		{
			id: "toggle-sidebar",
			group: "Actions",
			label: "Toggle left sidebar",
			shortcut: "toggleSidebar",
			run: () => setProjectsOpen((open) => !open),
		},
		{
			id: "toggle-inspector",
			group: "Actions",
			label: "Toggle right panel",
			shortcut: "toggleInspector",
			run: () => toggleInspectorPanel(),
		},
		{
			id: "terminal",
			group: "Actions",
			label: "Open terminal",
			shortcut: "toggleTerminal",
			run: () => openInspector("terminal"),
		},
		{
			id: "desktop",
			group: "Actions",
			label: "Open desktop",
			shortcut: "toggleDesktop",
			run: () => openInspector("desktop"),
		},
		{
			id: "pr",
			group: "Actions",
			label: "Open pull request",
			shortcut: "openPullRequest",
			disabled: !chatPullRequestRepository,
			run: () => openInspector("pr"),
		},
		{
			id: "side",
			group: "Actions",
			label: "Open side chat",
			disabled: !session.agentSessionId,
			run: () => openInspector("side"),
		},
		{
			id: "diff",
			group: "Actions",
			label: "Open diff",
			run: () => openInspector("diff"),
		},
		{
			id: "files",
			group: "Actions",
			label: "Open files",
			run: () => openInspector("files"),
		},
		{
			id: "memory",
			group: "Actions",
			label: "Open memory",
			run: openMemoryPage,
		},
		{
			id: "model",
			group: "Actions",
			label: "Choose model",
			shortcut: "modelPicker",
			run: () => document.getElementById(MODEL_PICKER_ID)?.click(),
		},
		{
			id: "copy-reply",
			group: "Actions",
			label: "Copy last reply",
			shortcut: "copyLastReply",
			disabled: !lastAgentMessageText(session.items),
			run: copyLastReply,
		},
		{
			id: "stop",
			group: "Actions",
			label: "Stop the running turn",
			shortcut: "stop",
			disabled: !turnRunning,
			run: stopOpenTurn,
		},
		{
			id: "add-project",
			group: "Actions",
			label: "Add project",
			run: openAddProject,
		},
		{
			id: "settings",
			group: "Actions",
			label: "Open settings",
			shortcut: "openSettings",
			run: openSettings,
		},
		{
			id: "shortcuts",
			group: "Actions",
			label: "Keyboard shortcuts",
			shortcut: "shortcuts",
			run: () => setShortcutsOpen(true),
		},
		...projectChats.flatMap(({ project, chats: listed }) =>
			listed.map(
				(chat): CommandPaletteItem => ({
					id: `chat:${chat.id}`,
					group: "Chats",
					label: chat.title,
					detail: projectDisplayName(project),
					run: () => openSidebarChat(chat.id),
				}),
			),
		),
		...(projects.data ?? []).map(
			(project): CommandPaletteItem => ({
				id: `project:${project.id}`,
				group: "Projects",
				label: projectDisplayName(project),
				run: () => selectProject(project.id),
			}),
		),
	];

	return (
		<SavedDefaultBranchesContext.Provider value={savedDefaultBranches}>
			<HeldForSetupContext.Provider value={heldProjects}>
				<SetupIndicatorContext.Provider value={setupIndicatorShown}>
					<div className="workspace-shell">
						<CommandPalette
							open={paletteOpen}
							onOpenChange={setPaletteOpen}
							items={paletteItems}
						/>
						<ShortcutHelpDialog
							open={shortcutsOpen}
							onOpenChange={setShortcutsOpen}
						/>
						<ProjectSidebar
							projects={projects.data ?? []}
							projectsLoading={projects.isPending}
							selectedProjectId={selectedProject?.id}
							onSelectProject={selectProject}
							expanded={shownProjectsOpen}
							onToggle={() => setProjectsOpen((open) => !open)}
							onAddProject={openAddProject}
							chats={visibleSidebarChats(sidebarChats, activeSessionId)}
							selectedChatId={activeSessionId}
							busyChatIds={busyChatIds}
							openTurnStatus={openTurnStatus}
							hasUserMessage={hasUserMessage}
							onSelectChat={openChat}
							onNewChat={startNewChat}
							onDeleteChat={deleteChat}
							onDeleteProject={removeProject}
							onOpenSettings={openSettings}
							projectChats={projectChats.map((group) => ({
								...group,
								chats: visibleSidebarChats(group.chats, activeSessionId),
							}))}
							onSelectChatInProject={(projectId, chatId) => {
								selectProject(projectId);
								openChat(chatId);
							}}
							onOpenMemory={() => {
								openMemoryPage();
								if (compact) setProjectsOpen(false);
							}}
							memoryActive={memoryPageOpen}
							onChatIntent={readAheadChat}
							onProjectIntent={(projectId) => {
								readAheadProjectStatus(queryClient, projectId);
								const latest = queryClient.getQueryData<readonly SidebarChat[]>(
									["agent-sessions", projectId],
								)?.[0];
								if (latest) readAheadChat(latest.id);
							}}
							onMemoryIntent={() => prefetchMemoryPage(queryClient)}
							renderedAtMs={renderedAtMs}
							account={account}
						/>
						<ProjectSettings
							onSetUpEnvironment={startProjectSetup}
							codexUsage={session.usage}
							open={settingsOpen}
							projectId={selectedProject?.id}
							projects={projects.data ?? []}
							selectedProject={selectedProject}
							onProjectAdded={(project) => {
								selectProject(project.id);
								void projects.refetch();
							}}
							onSignOut={() => {
								void signOut();
							}}
							onClose={() => setSettingsOpen(false)}
							initialSection={settingsSection}
						/>
						<UsageWarningBanner />
						<main
							ref={workspaceMainRef}
							className="workspace-main"
							data-memory-page={memoryPageOpen ? "true" : undefined}
							inert={layoutCompact && shownProjectsOpen}
							data-can-expand-inspector={
								inspectorOpen && !layoutCompact && !inspectorCompact
							}
						>
							{inspectorOpen && !layoutCompact && !inspectorCompact ? (
								<button
									type="button"
									className="workspace-sidebar-toggle workspace-inspector-expand"
									aria-label={
										inspectorExpanded
											? "Restore split view"
											: "Expand workspace"
									}
									title={
										inspectorExpanded
											? "Restore split view"
											: "Expand workspace"
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
								title={titleWithShortcut(
									inspectorOpen ? "Close right sidebar" : "Open right sidebar",
									inspectorShortcutHint,
								)}
								aria-expanded={inspectorOpen}
								aria-controls="workspace-inspector"
								onClick={toggleInspectorPanel}
							>
								<PanelRight size={16} />
							</button>
							{memoryPageOpen ? (
								<MemoryPage
									view={memoryView}
									onViewChange={setMemoryView}
									projects={projects.data}
									onOpenChat={openMemoryChat}
								/>
							) : null}
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
												<span className="session-title">
													{chatHeaderTitle(listedTitle, sessionTitle)}
												</span>
												{activeChat?.workingBranch && (
													<span
														className="session-title-meta"
														title="This chat's branch: each turn that changes code is committed and pushed here"
													>
														{activeChat.workingBranch}
													</span>
												)}
												{headerPullRequest && (
													<a
														className="session-title-meta"
														href={headerPullRequest.url}
														target="_blank"
														rel="noreferrer"
													>
														{headerPullRequest.draft ? "Draft PR" : "PR"} #
														{headerPullRequest.number}
													</a>
												)}
												{headerOpeningPullRequest && (
													<span
														className="session-title-meta session-title-pending"
														role="status"
													>
														<LoaderCircle
															size={12}
															className="workspace-status-spin"
															aria-hidden="true"
														/>
														{OPENING_PULL_REQUEST_TEXT}
													</span>
												)}
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
										{followUpLayout || !noProjects ? null : (
											<FirstProjectHeading />
										)}
										<SessionLauncher
											onOpenSettings={(section) => {
												setSettingsSection(section);
												setSettingsOpen(true);
											}}
											setupPlaceholder={setupPlaceholder}
											setupHold={
												heldView && selectedProject
													? {
															messageId: heldView.messageId,
															render: (showMessage) => (
																<HeldForSetupMessage
																	projectId={selectedProject.id}
																	text={heldView.text}
																	showMessage={showMessage}
																	failed={heldFailed}
																	{...(heldView.stored
																		? {
																				onEdit: (text: string) =>
																					void editQueuedMessage(
																						heldView.messageId,
																						text,
																					),
																				onRemove: () =>
																					removeQueuedMessage(
																						heldView.messageId,
																					),
																			}
																		: {})}
																	actions={{
																		pending: heldSetup.isPending,
																		onRetry: () => heldSetup.mutate("retry"),
																		onSendAnyway: () =>
																			heldSetup.mutate("plain"),
																		...(heldView.startsNewChat
																			? { onSetUpWithAgent: setUpHeldWithAgent }
																			: {}),
																	}}
																/>
															),
														}
													: undefined
											}
											prefill={
												composerPrefill?.send &&
												environmentSetupEpochRef.current !==
													sessionEpoch.current
													? undefined
													: composerPrefill
											}
											onPrefillSent={() => setComposerPrefill(undefined)}
											onSetUpEnvironment={() =>
												selectedProject && startProjectSetup(selectedProject.id)
											}
											initialDraft={
												recoveryDraft?.id === session.agentSessionId
													? recoveryDraft.prompt
													: ""
											}
											onRecovered={async (id, prompt, items) => {
												const projectId = selectedProject?.id;
												if (!projectId) return;
												setRecoveryDraft({ id, prompt: prompt ?? "" });
												sessionViews.current.delete(id);
												// A restore of this chat shows its transcript now; the
												// full reload below can take a while (it reconnects).
												const restored = sessionViewAfterRecovery(
													currentSessionRef.current,
													{ id, items },
												);
												if (restored) setSession(restored);
												else openChat(id);
												const epoch = sessionEpoch.current;
												try {
													const next = await getCodexSession({
														data: { projectId, sessionId: id, harnessId },
													});
													if (epoch !== sessionEpoch.current) return;
													rememberSessionView(next);
													setSession(next);
													await chats.refetch();
													await agentTasks.refetch();
												} catch (cause) {
													// The recovery itself is done; live updates catch up.
													console.warn(
														"Reloading the recovered chat failed.",
														cause,
													);
												}
											}}
											childTasks={agentTasks.data ?? []}
											backgroundRuns={backgroundRuns}
											memoryActions={memoryActions}
											key={composerKey.current.key}
											onDraftStarted={prewarmOpenChat}
											loadedCatalog={initialChatView?.side?.catalog}
											session={session}
											busy={composerBusy}
											listedTitle={composerDraft ? undefined : listedTitle}
											harnessId={harnessId}
											onHarnessIdChange={(id) => {
												if (session.turnStatus === "running") return;
												setHarnessId(id);
											}}
											onConnect={connectHarness}
											onSend={(text, modelId, options) => {
												askForFinishNotifications();
												const epoch = sessionEpoch.current;
												const previousTurnStatus = session.turnStatus;
												// A running chat keeps the follow-up. Clearing its id here is
												// what opened a second thread.
												const openChatId =
													session.agentSessionId ?? activeSessionId;
												const target = composerSubmitTarget({
													newChatDraft: composerDraftRef.current,
													openChatId,
													turnStatus: session.turnStatus,
												});
												if (target.waitForChat) {
													toast(
														"This chat is still opening. Send that message again in a moment.",
													);
													return Promise.resolve("unsent");
												}
												// The new-chat draft starts a new chat. Forget the previously open
												// one first: applySessionView drops updates while the draft flag is
												// set or when they belong to a different open chat.
												const startsNewChat = target.startsNewChat;
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
													}));
												}
												const scope = startsNewChat
													? { ...sessionScope(), sessionId: undefined }
													: {
															...sessionScope(),
															...(target.sessionId
																? { sessionId: target.sessionId }
																: {}),
														};
												const chatId = startsNewChat
													? undefined
													: (target.sessionId ?? activeSessionId);
												const messageId =
													options?.userMessageId ?? crypto.randomUUID();
												// Every send in the chat project setup opened says so
												// (a failed first send is retried flagged too).
												const environmentSetup =
													environmentSetupEpochRef.current === epoch;
												const setupStatus =
													projectSetup.data === null
														? "missing"
														: projectSetup.data?.status;
												// Only the setup request waits for the environment (the
												// server holds it in its chat); a task goes at once.
												const heldForSetup =
													Boolean(selectedProject) &&
													setupStatus !== "missing" &&
													sendWaitsForSetup(setupStatus, {
														environmentSetup,
														approvesPlan: options?.approvesPlan,
														continueOn: options?.continueOn,
													});
												return new Promise<ComposerSendResult>((settle) => {
													const pending: PendingSend = {
														epoch,
														scope,
														chatId,
														startsNewChat,
														previousTurnStatus,
														messageId,
														text,
														modelId,
														...(options?.reasoningId
															? { variant: options.reasoningId }
															: {}),
														...(options?.speed ? { speed: options.speed } : {}),
														...(options?.alternateContext !== undefined
															? { alternateContext: options.alternateContext }
															: {}),
														...(options?.approvesPlan
															? { approvesPlan: true }
															: {}),
														...(options?.continueOn
															? { continueOn: options.continueOn }
															: {}),
														...(options?.attachments?.length
															? { attachments: options.attachments }
															: {}),
														...(options?.baseBranch
															? { baseBranch: options.baseBranch }
															: {}),
														...(environmentSetup
															? { environmentSetup: true }
															: {}),
														...(heldForSetup ? { heldForSetup: true } : {}),
														settle,
													};
													// A project with no environment record yet: held in this
													// tab until there is one (the server cannot store it).
													// Otherwise a send during setup, or after a failed setup,
													// goes to the server, which keeps it in the chat.
													if (selectedProject && setupStatus === "missing") {
														if (heldForSetupRef.current)
															abandonSend(heldForSetupRef.current, null);
														heldForSetupRef.current = pending;
														setHeldForSetup(new Set([selectedProject.id]));
														setHeldMessage({
															projectId: selectedProject.id,
															messageId: pending.messageId,
															text: pending.text,
															startsNewChat: pending.startsNewChat,
														});
														return;
													}
													// A newer send replaces one still waiting for sign-in.
													if (pendingSendRef.current)
														abandonSend(pendingSendRef.current, null);
													if (session.connection.status === "authenticated") {
														// A new chat's first message never falls back to the old chat.
														void deliverSend(
															pending,
															startsNewChat
																? { ...session, agentSessionId: null }
																: session,
														);
														return;
													}
													void connectThenSend(pending);
												});
											}}
											onStop={stopOpenTurn}
											olderItems={
												session.hasOlderItems
													? { loading: olderLoading, onLoad: loadOlderItems }
													: undefined
											}
											stopping={
												!!activeSessionId && stoppingChatId === activeSessionId
											}
											onRemoveQueued={removeQueuedMessage}
											onEditQueued={editQueuedMessage}
											onSendQueued={(messageId, text) => {
												const epoch = sessionEpoch.current;
												const previous = session.items.find(
													(item) => item.id === messageId,
												);
												setSession((current) => ({
													...current,
													items: current.items.map((item) =>
														item.kind === "userMessage" && item.id === messageId
															? {
																	...item,
																	...(text ? { text } : {}),
																	released: true as const,
																}
															: item,
													),
												}));
												void releaseQueued({
													data: {
														...sessionScope(),
														messageId,
														...(text ? { text } : {}),
													},
												})
													.then((next) => applySessionView(epoch, next))
													.catch((cause) => {
														toast.error(publicFailureMessage(cause));
														if (!previous || epoch !== sessionEpoch.current)
															return;
														setSession((current) => ({
															...current,
															items: current.items.map((item) =>
																item.id === messageId ? previous : item,
															),
														}));
													});
											}}
											onOpenInspector={openInspector}
											onOpenFile={openMentionedFile}
											projects={projects.data ?? []}
											selectedProject={selectedProject}
											onSelectProject={(id) => {
												selectProject(id);
												setProjectPickerOpen(false);
											}}
											projectPickerOpen={projectPickerOpen}
											onProjectPickerOpenChange={setProjectPickerOpen}
										/>
										{projects.error && !projects.data && (
											<p role="alert">
												Unable to load projects.{" "}
												<button
													type="button"
													onClick={() => void projects.refetch()}
												>
													Retry
												</button>
											</p>
										)}
									</div>
								</section>
								<div className="inspector-frame">
									<WorkspaceInspector
										sideChat={
											session.agentSessionId ? (
												<SideChat
													projectId={selectedProject?.id}
													parent={session}
													parentTurnStatus={session.turnStatus}
													harnessId={harnessId}
													onHarnessIdChange={(id) => {
														if (session.turnStatus === "running") return;
														setHarnessId(id);
													}}
													onConnect={connectHarness}
													onOpenInspector={openInspector}
													onOpenFile={openMentionedFile}
													projects={projects.data ?? []}
													selectedProject={selectedProject}
													loadedCatalog={initialChatView?.side?.catalog}
												/>
											) : undefined
										}
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
										harnessId={harnessId}
										modelId={session.listedModelId}
										onReviewStarted={(sessionId) => {
											void chats.refetch();
											openChat(sessionId);
										}}
										memoryFocus={memoryFocus}
										onStartDesktop={() => requestDesktop()}
										onViewIntent={intendView}
										onOpenChat={(chatId) => {
											if (!sidebarChats.some((chat) => chat.id === chatId))
												return false;
											openChat(chatId);
											return true;
										}}
										pullRequest={chatPullRequestRepository}
										pullRequestSummary={
											sessionPullRequest
												? listedPullRequestSummary(sessionPullRequest)
												: undefined
										}
										overview={
											<WorkspaceOverview
												tasks={agentTasks.data ?? []}
												items={session.items}
												changes={fileChanges}
												repository={selectedProject?.fullName}
												desktop={desktop}
												onOpen={openInspector}
												onIntent={intendView}
												pullRequests={overviewPullRequests}
											/>
										}
									/>
								</div>
							</WorkspacePanes>
						</main>
					</div>
				</SetupIndicatorContext.Provider>
			</HeldForSetupContext.Provider>
		</SavedDefaultBranchesContext.Provider>
	);
}
