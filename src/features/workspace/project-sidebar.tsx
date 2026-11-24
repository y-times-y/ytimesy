import { useQuery } from "@tanstack/react-query";
import {
	Archive,
	BookMarked,
	Check,
	ChevronRight,
	CircleDot,
	Clock3,
	Cloud,
	Cpu,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	MessageCircleQuestion,
	PanelLeft,
	Pin,
	Plus,
	TriangleAlert,
	X,
} from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
	type CSSProperties,
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Wordmark } from "#/components/brand/wordmark";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { titleWithShortcut } from "#/domain/keyboard-shortcuts";
import { machineSpecText } from "#/domain/machine-size";
import { type Project, projectDisplayName } from "#/domain/projects";
import { isTurnRunning, type SessionTurnStatus } from "#/domain/session-item";
import {
	type SidebarChatStatus,
	type SidebarPullRequest,
	sidebarChatStatus,
	sidebarChatStatusLabel,
	sidebarChatUnread,
} from "#/domain/sidebar-chat-status";
import {
	CHAT_SEEN_SINCE_STORAGE_KEY,
	CHAT_SEEN_STORAGE_KEY,
	compactRelativeAge,
	newChatIsActive,
	type ProjectChats,
	parseSeenChatKeys,
	parseSeenSince,
	pinnedChatStorageValue,
	projectColor,
	recentSidebarChats,
	recentY2Chats,
	SIDEBAR_PINNED_CHATS_KEY,
	type SidebarChat,
	type SidebarStatusGroup,
	seenChatStorageValue,
	sidebarChatIsRunning,
	sidebarChatSeenKey,
	sidebarStatusGroup,
	togglePinnedChatIds,
	trimmedSeenChatKeys,
} from "#/domain/sidebar-chats";
import {
	threadSections,
	type Y2Row,
	y2NeedsYouLabel,
	y2Rows,
} from "#/domain/sidebar-tree";
import { threadColor } from "#/domain/thread-color";
import { threadLabel } from "#/domain/thread-label";
import {
	accountDisplayName,
	accountInitials,
} from "#/domain/workspace-settings";
import { SUPER_AGENT_NAME } from "#/domain/y-squared";
import {
	dropFirstPaintStyles,
	FIRST_PAINT_ROWS_SCRIPT,
	useFirstPaint,
} from "../app/first-paint";
import { useShortcutHint } from "../app/keyboard-shortcuts";
import { requestJson } from "../projects/api";
import { ThreadHoverCard } from "./thread-hover-card";
import { ThreadMark } from "./thread-mark";
import { YSquaredMark } from "./y-squared-mark";

/** The Threads list's groups, in order: what needs the person comes first. */
const THREAD_GROUPS: readonly {
	readonly status: SidebarStatusGroup;
	readonly label: string;
}[] = [
	{ status: "needs-you", label: "Needs you" },
	{ status: "working", label: "Working" },
	{ status: "done", label: "Recently finished" },
];

/** Who is signed in, as the account button shows them. */
export type SidebarAccount = {
	readonly name?: string | null;
	readonly email?: string | null;
	readonly image?: string | null;
};

interface ProjectSidebarProps {
	projects: Project[];
	projectsLoading: boolean;
	selectedProjectId?: string;
	onSelectProject: (id: string) => void;
	expanded: boolean;
	onToggle: () => void;
	onAddProject: () => void;
	chats: readonly SidebarChat[];
	selectedChatId?: string;
	busyChatIds?: readonly string[];
	openTurnStatus?: SessionTurnStatus;
	hasUserMessage?: boolean;
	onSelectChat?: (id: string) => void;
	/** Opens the chat with its pull request in ytimesy's own review panel. */
	onOpenChatPullRequest?: (
		projectId: string | undefined,
		chatId: string,
	) => void;
	onNewChat: (projectId?: string) => void;
	onDeleteChat?: (id: string) => void;
	onDeleteProject?: (id: string) => void;
	onOpenSettings?: () => void;
	/** Every project's chats, for the Recent list and ordering projects by activity. */
	projectChats?: readonly ProjectChats<Project>[];
	/** Opens a chat that may belong to another project (the Recent list). */
	onSelectChatInProject?: (projectId: string, chatId: string) => void;
	/** Opens the full-page Pull requests or Issues view across every connected repository. */
	onOpenWorkItems?: (kind: "pull-requests" | "issues") => void;
	/** Which of those pages is open. */
	workItemsActive?: "pull-requests" | "issues" | null;
	/** What waits on the signed-in user in each: the badge. Zero shows none. */
	waitingOnYou?: { readonly pullRequests: number; readonly issues: number };
	/** Reads the page ahead when the pointer or focus reaches its entry. */
	onWorkItemsIntent?: () => void;
	/** Opens the full-page Memory view (graph and list). */
	onOpenMemory?: () => void;
	memoryActive?: boolean;
	/** The pointer or focus reached a chat: it may open next. */
	onChatIntent?: (chatId: string) => void;
	/** The pointer or focus reached another project: it may open next. */
	onProjectIntent?: (projectId: string) => void;
	/** The pointer or focus reached Memory: it may open next. */
	onMemoryIntent?: () => void;
	/** When the server rendered the page: relative times hydrate from it. */
	renderedAtMs?: number;
	/** The signed-in user as the page loaded, until the account read answers. */
	account?: SidebarAccount;
}

export function ProjectSidebar({
	projects,
	projectsLoading,
	selectedProjectId,
	onSelectProject,
	expanded,
	onToggle,
	onAddProject,
	chats,
	selectedChatId,
	busyChatIds = [],
	openTurnStatus,
	hasUserMessage = false,
	onSelectChat,
	onOpenChatPullRequest,
	onNewChat,
	onDeleteChat,
	onDeleteProject,
	onOpenSettings,
	projectChats = [],
	onSelectChatInProject,
	onOpenWorkItems,
	workItemsActive = null,
	waitingOnYou,
	onWorkItemsIntent,
	onOpenMemory,
	memoryActive = false,
	onChatIntent,
	onProjectIntent,
	onMemoryIntent,
	renderedAtMs,
	account,
}: ProjectSidebarProps) {
	const sidebarToggle = useRef<HTMLButtonElement>(null);
	const leftToggle = useRef<HTMLButtonElement>(null);
	const sidebarHint = useShortcutHint("toggleSidebar");
	const newChatHint = useShortcutHint("newChat");
	const [nowMs, setNowMs] = useState(() => renderedAtMs ?? Date.now());
	const firstPaint = useFirstPaint();
	const [seenKeys, setSeenKeys] = useState<readonly string[]>(() =>
		parseSeenChatKeys(readStorage(CHAT_SEEN_STORAGE_KEY)),
	);
	// Replies from before this browser tracked seen chats count as read.
	const [seenSinceMs] = useState<number | null>(() => {
		if (typeof window === "undefined") return null;
		const stored = parseSeenSince(readStorage(CHAT_SEEN_SINCE_STORAGE_KEY));
		if (stored !== null) return stored;
		const now = Date.now();
		writeStorage(CHAT_SEEN_SINCE_STORAGE_KEY, String(now));
		return now;
	});
	const [pinnedChatIds, setPinnedChatIds] = useState(
		firstPaint.choices.pinnedChatIds,
	);
	// Until hydrated this renders the server's markup: no pins, folds or
	// unread marks. The first-paint script shows the saved
	// choices meanwhile (src/features/app/first-paint.ts).
	const hydrated = firstPaint.hydrated;
	const shownPinnedIds = hydrated ? pinnedChatIds : [];
	const shownSeenKeys = hydrated ? seenKeys : [];
	const shownSeenSinceMs = hydrated ? seenSinceMs : null;
	// The open project's chats are the freshest list; the others come from projectChats.
	const groups = projects.map((project) => ({
		project,
		chats:
			project.id === selectedProjectId
				? chats
				: (projectChats.find((group) => group.project.id === project.id)
						?.chats ?? []),
	}));
	const [settledExpanded, setSettledExpanded] = useState(false);
	// The Threads list shows every project's threads, or one project's.
	const [filterProjectId, setFilterProjectId] = useState<string | null>(null);
	const filterProject = projects.find(
		(project) => project.id === filterProjectId,
	);
	// Super agents (the Y² chats) are one row per project with Y on; every
	// other chat is a thread in the one Threads list, newest activity first
	// (pins on top), the project named on its row.
	const y2Chats = recentY2Chats(groups);
	const allThreads = recentSidebarChats(groups, shownPinnedIds);
	const threadRows = filterProject
		? allThreads.filter((row) => row.project.id === filterProject.id)
		: allThreads;
	const yRows = y2Rows({
		y2: y2Chats,
		threads: allThreads,
		statusOf: chatStatus,
	});
	// A project with Y on always has its Super agent row, from the project
	// itself, not from its chat list: a list that has not arrived (or has no
	// Y² chat yet) must not make the row vanish.
	const yPending = projects.filter(
		(project) =>
			project.yEnabled && !yRows.some((row) => row.project.id === project.id),
	);
	// "+" starts a chat in the filtered project, else the open one.
	const newChatProject =
		filterProject ??
		projects.find((project) => project.id === selectedProjectId) ??
		projects[0];
	const selected = projects.find((project) => project.id === selectedProjectId);
	const newChatActive = newChatIsActive({
		projectSelected: Boolean(selected),
		hasUserMessage,
	});

	// Hydration renders the server's times; this client's clock takes over before the paint.
	useLayoutEffect(() => {
		setNowMs(Date.now());
		const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
		return () => window.clearInterval(timer);
	}, []);

	useLayoutEffect(() => {
		if (hydrated) dropFirstPaintStyles();
	}, [hydrated]);

	useEffect(() => {
		const chat = chats.find((row) => row.id === selectedChatId);
		if (!chat) return;
		const turnStatus = openTurnStatus ?? chat.turnStatus;
		if (isTurnRunning(turnStatus ?? "idle")) return;
		const key = sidebarChatSeenKey({ ...chat, turnStatus });
		setSeenKeys((current) => {
			if (current.includes(key)) return current;
			const next = trimmedSeenChatKeys([...current, key]);
			writeStorage(CHAT_SEEN_STORAGE_KEY, seenChatStorageValue(next));
			return next;
		});
	}, [selectedChatId, openTurnStatus, chats]);

	function persistPinned(next: readonly string[]) {
		setPinnedChatIds(next);
		writeStorage(SIDEBAR_PINNED_CHATS_KEY, pinnedChatStorageValue(next));
	}

	function toggleProjects() {
		onToggle();
		// Focus follows the toggle that stays: the sidebar's own once open,
		// the chat's top-left one once closed.
		requestAnimationFrame(() =>
			(expanded ? leftToggle : sidebarToggle).current?.focus(),
		);
	}

	/** Main's turn, or a helper's (an active turn the list reports). */
	function chatRunning(chat: SidebarChat) {
		return (
			sidebarChatIsRunning({
				chatId: chat.id,
				turnStatus:
					chat.id === selectedChatId ? openTurnStatus : chat.turnStatus,
				busyChatIds,
				openChatId: selectedChatId,
				openTurnStatus,
			}) || Boolean(chat.workingSince)
		);
	}

	/** The open chat's own turn is fresher than the listed one. */
	function chatWaitingOn(chat: SidebarChat) {
		return chat.id === selectedChatId && openTurnStatus === "running"
			? null
			: chat.waitingOn;
	}

	function chatStatus(chat: SidebarChat): SidebarStatusGroup {
		return sidebarStatusGroup({
			running: chatRunning(chat),
			waitingOn: chatWaitingOn(chat),
			waitsForSetup: chat.waitsForSetup,
		});
	}

	function rowStatus(
		chat: SidebarChat,
		seen: { readonly keys: readonly string[]; readonly sinceMs: number | null },
	): SidebarChatStatus {
		const running = chatRunning(chat);
		const selected = chat.id === selectedChatId;
		return sidebarChatStatus({
			running,
			waitsForSetup: chat.waitsForSetup,
			workingSince: chat.workingSince,
			waitingOn: chatWaitingOn(chat),
			pr: chat.pr,
			unread: sidebarChatUnread({
				selected,
				running,
				turnStatus: selected
					? (openTurnStatus ?? chat.turnStatus)
					: chat.turnStatus,
				updatedAt: chat.updatedAt,
				seen: seen.keys.includes(sidebarChatSeenKey(chat)),
				seenSinceMs: seen.sinceMs,
			}),
		});
	}

	/**
	 * Before hydration: what the rows script needs to mark this row from this
	 * browser's seen chats (src/features/app/first-paint.ts).
	 */
	function firstPaintMarks(chat: SidebarChat) {
		if (hydrated) return {};
		const unseenReply =
			rowStatus(chat, { keys: [], sinceMs: Number.NEGATIVE_INFINITY }).kind ===
			"unread";
		return {
			"data-seen-key": sidebarChatSeenKey(chat),
			"data-updated-at": chat.updatedAt ?? undefined,
			"data-unread-mark": unseenReply ? "true" : undefined,
		};
	}

	/** A top-level section's header row: the title left, its actions right. */
	function sectionHeader(
		id: string,
		title: ReactNode,
		action?: ReactNode,
		className = "sidebar-status-heading sidebar-section-header",
	) {
		return (
			<div className={className}>
				<h3 className="sidebar-section-title" id={`sidebar-section-${id}`}>
					{title}
				</h3>
				{action ? (
					<div className="sidebar-section-actions">{action}</div>
				) : null}
			</div>
		);
	}

	/**
	 * The Y² section: one flat row per Y project (the header is the only "Y²"
	 * text): the mark, the project's name, its last activity and a grey line
	 * summarising its threads.
	 */
	function y2Section(
		rows: readonly Y2Row<Project>[],
		pending: readonly Project[] = [],
	) {
		if (!rows.length && !pending.length) return null;
		return (
			<section
				className="sidebar-y-section sidebar-y2-section"
				data-section="y2"
				aria-labelledby="sidebar-section-y2"
			>
				{sectionHeader("y2", SUPER_AGENT_NAME)}
				<ul className="sidebar-chats sidebar-y2-list">
					{rows.map((row) => y2Row(row))}
					{pending.map((project) => y2PendingRow(project))}
				</ul>
			</section>
		);
	}

	/** A Y project whose chats have not loaded: its place and name, until its Super agent row arrives. */
	function y2PendingRow(project: Project) {
		const name = projectDisplayName(project);
		const hasThreads = allThreads.some((row) => row.project.id === project.id);
		return (
			<li
				key={`pending-${project.id}`}
				className="sidebar-chat-row sidebar-y2-row"
				data-project-id={project.id}
				data-role="y2"
				data-pending="true"
				aria-busy="true"
			>
				{/* The Super agent's id comes with the project: the row opens it
				    before the chat list has arrived. Without one (Y on, no thread
				    yet) the row opens the project, where its first thread starts. */}
				<button
					type="button"
					className="sidebar-chat"
					title={name}
					aria-current={
						project.ySquaredId && project.ySquaredId === selectedChatId
							? "page"
							: undefined
					}
					onClick={() => {
						const id = project.ySquaredId;
						if (!id) {
							if (project.id !== selectedProjectId) onSelectProject(project.id);
							return;
						}
						if (project.id !== selectedProjectId && onSelectChatInProject)
							onSelectChatInProject(project.id, id);
						else onSelectChat?.(id);
					}}
				>
					<span className="sidebar-chat-lead" aria-hidden="true">
						<YSquaredMark size={16} />
					</span>
					<span className="sidebar-chat-body">
						<span className="sidebar-chat-title">{name}</span>
						<span className="sidebar-chat-meta">
							{hasThreads
								? "Loading…"
								: project.ySquaredId
									? "No threads yet"
									: "Getting ready"}
						</span>
					</span>
				</button>
			</li>
		);
	}

	function y2Row({
		chat,
		project,
		working,
		needsYou,
		summary,
		activityAt,
	}: Y2Row<Project>) {
		const selected = chat.id === selectedChatId;
		const name = projectDisplayName(project);
		const shown = rowStatus(chat, {
			keys: shownSeenKeys,
			sinceMs: shownSeenSinceMs,
		});
		const age = compactRelativeAge(activityAt ?? chat.updatedAt, nowMs);
		return (
			<li
				key={chat.id}
				className="sidebar-chat-row sidebar-y2-row"
				data-chat-id={chat.id}
				data-project-id={project.id}
				data-selected={selected}
				data-role="y2"
				{...firstPaintMarks(chat)}
			>
				<button
					type="button"
					className="sidebar-chat"
					data-selected={selected}
					data-status={shown.kind}
					title={`${name} · ${summary}`}
					aria-current={selected ? "page" : undefined}
					onPointerEnter={() => {
						onChatIntent?.(chat.id);
						if (project && project.id !== selectedProjectId)
							onProjectIntent?.(project.id);
					}}
					onFocus={() => {
						onChatIntent?.(chat.id);
						if (project && project.id !== selectedProjectId)
							onProjectIntent?.(project.id);
					}}
					onClick={() =>
						project.id !== selectedProjectId && onSelectChatInProject
							? onSelectChatInProject(project.id, chat.id)
							: onSelectChat?.(chat.id)
					}
				>
					<span className="sidebar-chat-lead" aria-hidden="true">
						<YSquaredMark size={16} live={working > 0} />
					</span>
					<span className="sidebar-chat-body">
						<span className="sidebar-chat-title">{name}</span>
						<span className="sidebar-chat-meta">{summary}</span>
					</span>
				</button>
				<div className="sidebar-chat-trailing">
					{shown.kind !== "idle" ? (
						<SidebarChatStatusMark
							status={shown}
							label={sidebarChatStatusLabel(shown, nowMs)}
							age={null}
							askingAsDot
						/>
					) : needsYou ? (
						<span
							className="sidebar-chat-needs-you"
							role="img"
							aria-label={y2NeedsYouLabel(needsYou)}
						/>
					) : age ? (
						<span className="sidebar-chat-age">{age}</span>
					) : null}
				</div>
			</li>
		);
	}

	/**
	 * The Threads section: the Y projects' threads as one flat list (Needs
	 * you, Working, the latest finished), the rest folded into "Settled N".
	 * Before hydration the Settled rows render hidden, so the rows script can
	 * show a saved pin that sits past the fold.
	 */
	function threadBlocks(
		rows: readonly { chat: SidebarChat; project: Project }[],
		{
			listId,
			settledShown,
			onToggleSettled,
			empty,
		}: {
			listId: string;
			settledShown: boolean;
			onToggleSettled: () => void;
			empty: string;
		},
	) {
		const { list, settled } = threadSections(rows, chatStatus, selectedChatId);
		const settledOpen = settledShown || !hydrated;
		return (
			<>
				{THREAD_GROUPS.map(({ status, label }) => {
					const inGroup = list.filter((row) => chatStatus(row.chat) === status);
					if (!inGroup.length) return null;
					return (
						<div
							key={status}
							className="sidebar-thread-group"
							data-group-name={status}
						>
							<h4 className="sidebar-thread-group-title">
								{label}
								<span className="sidebar-status-count">{inGroup.length}</span>
							</h4>
							<ul className="sidebar-chats sidebar-threads">
								{inGroup.map(({ chat, project }) =>
									chatRow(chat, { project, thread: true }),
								)}
							</ul>
						</div>
					);
				})}
				{!list.length && !settled.length ? (
					<p className="sidebar-empty">{empty}</p>
				) : null}
				{settled.length ? (
					<div className="sidebar-settled" data-open={settledOpen}>
						<button
							type="button"
							className="sidebar-settled-toggle"
							aria-expanded={settledOpen}
							aria-controls={listId}
							onClick={onToggleSettled}
						>
							<ChevronRight
								className="sidebar-settled-chevron"
								size={14}
								strokeWidth={1.5}
								aria-hidden="true"
							/>
							<span>Settled</span>
							<span className="sidebar-status-count">{settled.length}</span>
						</button>
						{settledOpen ? (
							<ul
								id={listId}
								className="sidebar-chats sidebar-threads sidebar-settled-list"
								aria-label="Settled threads"
							>
								{settled.map(({ chat, project }) =>
									chatRow(chat, {
										project,
										thread: true,
										pastFold: !hydrated,
									}),
								)}
							</ul>
						) : null}
					</div>
				) : null}
			</>
		);
	}

	function threadsSection() {
		if (!projects.length) return null;
		const name = newChatProject ? projectDisplayName(newChatProject) : "";
		return (
			<section
				className="sidebar-y-section sidebar-threads-section"
				data-section="threads"
				aria-labelledby="sidebar-section-threads"
			>
				{sectionHeader(
					"threads",
					"Threads",
					<>
						{projects.length > 1 ? (
							<select
								className="sidebar-thread-filter"
								aria-label="Show threads of"
								value={filterProject?.id ?? ""}
								onChange={(event) =>
									setFilterProjectId(event.target.value || null)
								}
							>
								<option value="">All projects</option>
								{projects.map((project) => (
									<option key={project.id} value={project.id}>
										{projectDisplayName(project)}
									</option>
								))}
							</select>
						) : null}
						{filterProject && onDeleteProject ? (
							<button
								type="button"
								className="sidebar-section-action sidebar-section-archive"
								aria-label={`Archive ${name}`}
								title="Archive project"
								onClick={() => {
									setFilterProjectId(null);
									onDeleteProject(filterProject.id);
								}}
							>
								<Archive size={14} strokeWidth={1.5} />
							</button>
						) : null}
						{newChatProject ? (
							<button
								type="button"
								className="sidebar-section-add"
								aria-label={`New chat in ${name}`}
								title={titleWithShortcut("New chat", newChatHint)}
								data-active={
									newChatProject.id === selectedProjectId && newChatActive
										? "true"
										: undefined
								}
								onClick={() => onNewChat(newChatProject.id)}
							>
								<Plus size={14} strokeWidth={1.5} />
							</button>
						) : null}
					</>,
				)}
				{threadBlocks(threadRows, {
					listId: "sidebar-settled-list",
					settledShown: settledExpanded,
					onToggleSettled: () => setSettledExpanded((value) => !value),
					empty: "No threads yet.",
				})}
			</section>
		);
	}

	function chatRow(
		chat: SidebarChat,
		{
			project,
			pastFold = false,
			thread = false,
		}: {
			/** In Recent and Threads: the project the chat belongs to. */
			project?: Project;
			/** Before hydration: past the Settled fold, hidden unless a saved pin. */
			pastFold?: boolean;
			/** A Threads row: flat, a second line of metadata, a waiting thread shows a dot. */
			thread?: boolean;
		} = {},
	) {
		const status = chatStatus(chat);
		const shown = rowStatus(chat, {
			keys: shownSeenKeys,
			sinceMs: shownSeenSinceMs,
		});
		const label = sidebarChatStatusLabel(shown, nowMs);
		const age = compactRelativeAge(chat.updatedAt, nowMs);
		const pinned = shownPinnedIds.includes(chat.id);
		const projectName = project ? projectDisplayName(project) : null;
		const prInMeta = thread && shown.kind === "pr" ? shown.pr : null;
		const row = (
			<li
				key={chat.id}
				className="sidebar-chat-row"
				data-chat-id={chat.id}
				data-selected={chat.id === selectedChatId}
				data-pinned={pinned ? "true" : undefined}
				data-role={chat.role}
				data-variant={thread ? "thread" : undefined}
				data-group={thread ? status : undefined}
				data-done-overflow={pastFold ? "true" : undefined}
				// The thread's colour: its Y and its working spinner.
				style={
					thread
						? ({ "--thread-color": threadColor(chat) } as CSSProperties)
						: undefined
				}
				{...firstPaintMarks(chat)}
			>
				<button
					type="button"
					className="sidebar-chat"
					data-selected={chat.id === selectedChatId}
					data-activity={
						status === "needs-you"
							? "needs-you"
							: status === "working"
								? "running"
								: undefined
					}
					data-status={shown.kind}
					// The status tooltip names the row's state; the title only the chat.
					title={
						label
							? undefined
							: [chat.title, projectName].filter(Boolean).join(" · ")
					}
					aria-current={chat.id === selectedChatId ? "page" : undefined}
					onPointerEnter={() => {
						onChatIntent?.(chat.id);
						if (project && project.id !== selectedProjectId)
							onProjectIntent?.(project.id);
					}}
					onFocus={() => {
						onChatIntent?.(chat.id);
						if (project && project.id !== selectedProjectId)
							onProjectIntent?.(project.id);
					}}
					onClick={() =>
						project && project.id !== selectedProjectId && onSelectChatInProject
							? onSelectChatInProject(project.id, chat.id)
							: onSelectChat?.(chat.id)
					}
				>
					{thread ? (
						<>
							{/* The thread's Y, in its own colour, as the super agent has its Y. */}
							<span className="sidebar-chat-lead" aria-hidden="true">
								<ThreadMark size={16} />
							</span>
							<span className="sidebar-chat-body">
								<span className="sidebar-chat-title">{chat.title}</span>
								<span className="sidebar-chat-meta">
									{project ? (
										<span className="sidebar-chat-meta-project">
											<span
												className="sidebar-project-dot"
												style={{ background: projectColor(project.id) }}
												aria-hidden="true"
											/>
											{/* A numbered name ("ytimesy-12") already says the project. */}
											{chat.threadNumber == null ? (
												<span>{projectName}</span>
											) : null}
											<span className="thread-id" data-in="sidebar">
												{threadLabel(projectName, chat)}
											</span>
										</span>
									) : null}
									{chat.listedModelId ? (
										<span
											className="sidebar-chat-meta-icon"
											data-meta="model"
											title={chat.listedModelId}
										>
											<Cpu size={12} strokeWidth={1.5} aria-hidden="true" />
											<span className="sr-only">{chat.listedModelId}</span>
										</span>
									) : null}
									{chat.workspaceId ? (
										<span
											className="sidebar-chat-meta-icon"
											data-meta="machine"
											title="Has a cloud workspace"
										>
											<Cloud size={12} strokeWidth={1.5} aria-hidden="true" />
											<span className="sr-only">Cloud workspace</span>
										</span>
									) : null}
								</span>
							</span>
						</>
					) : (
						<>
							{/* The icon column every sidebar row shares: in Recent, the
							    chat's project; under a project, empty so titles line up
							    with the project's name. */}
							<span className="sidebar-chat-lead" aria-hidden="true">
								{project ? (
									<span
										className="sidebar-project-dot"
										style={{ background: projectColor(project.id) }}
									/>
								) : null}
							</span>
							<span className="sidebar-chat-title">{chat.title}</span>
							{projectName ? (
								<span className="sr-only">{projectName}</span>
							) : null}
						</>
					)}
					{shown.kind === "working" ? (
						<span className="sr-only">Working</span>
					) : null}
				</button>
				<div className="sidebar-chat-trailing">
					<button
						type="button"
						className="sidebar-chat-pin"
						aria-label={pinned ? `Unpin ${chat.title}` : `Pin ${chat.title}`}
						aria-pressed={pinned}
						title={pinned ? "Unpin chat" : "Pin chat"}
						data-pinned={pinned ? "true" : undefined}
						onClick={(event) => {
							event.stopPropagation();
							persistPinned(togglePinnedChatIds(pinnedChatIds, chat.id));
						}}
					>
						<Pin
							size={14}
							strokeWidth={1.5}
							fill={pinned ? "currentColor" : "none"}
						/>
					</button>
					{onDeleteChat ? (
						<button
							type="button"
							className="sidebar-chat-archive"
							aria-label={`Archive ${chat.title}`}
							title="Archive chat"
							onClick={(event) => {
								event.stopPropagation();
								onDeleteChat(chat.id);
							}}
						>
							<Archive size={14} strokeWidth={1.5} />
						</button>
					) : null}
					<SidebarChatStatusMark
						status={shown}
						label={label}
						age={age}
						onOpenPullRequest={
							onOpenChatPullRequest
								? () => onOpenChatPullRequest(project?.id, chat.id)
								: undefined
						}
						askingAsDot={thread}
						prInMeta={thread}
					/>
				</div>
				{prInMeta ? (
					<div className="sidebar-chat-meta-end">
						<SidebarChatPr
							pr={prInMeta}
							label={label}
							hashed
							onOpen={
								onOpenChatPullRequest
									? () => onOpenChatPullRequest(project?.id, chat.id)
									: undefined
							}
						/>
					</div>
				) : null}
			</li>
		);
		if (thread && project) {
			return (
				<ThreadHoverCard
					key={chat.id}
					data={{
						id: threadLabel(projectName, chat),
						title: chat.title,
						projectName,
						projectColor: projectColor(project.id),
						status: label,
						model: chat.listedModelId ?? null,
						cloud: Boolean(chat.workspaceId),
						machine: chat.workspaceId
							? machineSpecText(project.machineSize)
							: null,
						pullRequest: chat.pr ?? null,
					}}
					onOpenPullRequest={
						onOpenChatPullRequest
							? () => onOpenChatPullRequest(project.id, chat.id)
							: undefined
					}
				>
					{row}
				</ThreadHoverCard>
			);
		}
		if (!label) return row;
		return (
			<TooltipPrimitive.Root key={chat.id}>
				<TooltipPrimitive.Trigger asChild>{row}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						className="sidebar-status-tooltip"
						side="right"
						sideOffset={10}
					>
						{shown.kind === "working" ? (
							<LiveStatusLabel status={shown} />
						) : (
							label
						)}
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		);
	}

	return (
		// Status tooltips hold no controls: they close as the pointer leaves the row.
		<TooltipPrimitive.Provider delayDuration={300} disableHoverableContent>
			{/* Top left of the chat while the sidebar is closed (as the right
			    sidebar's toggle is top right); open, the
			    sidebar's header has its own toggle (CSS picks, from <html data-sidebar>). */}
			<button
				ref={leftToggle}
				type="button"
				className="workspace-sidebar-toggle left-sidebar-toggle"
				aria-label={expanded ? "Close left sidebar" : "Open left sidebar"}
				title={titleWithShortcut(
					expanded ? "Close left sidebar" : "Open left sidebar",
					sidebarHint,
				)}
				aria-expanded={expanded}
				aria-controls="project-sidebar"
				onClick={toggleProjects}
			>
				<PanelLeft size={16} strokeWidth={1.5} />
			</button>
			<div className="project-sidebar-frame">
				<button
					type="button"
					className="sidebar-backdrop"
					aria-label="Close chats"
					tabIndex={-1}
					onClick={toggleProjects}
				/>
				<aside
					id="project-sidebar"
					className="project-sidebar"
					aria-label="Projects and chats"
					inert={!expanded}
					aria-hidden={!expanded}
					onKeyDown={(event) => {
						if (event.key === "Escape" && expanded) {
							event.preventDefault();
							toggleProjects();
						}
					}}
				>
					<div className="sidebar-brand-row">
						<a href="/" className="brand" aria-label="Y times Y home">
							<Wordmark />
						</a>
						<button
							ref={sidebarToggle}
							type="button"
							className="workspace-sidebar-toggle sidebar-brand-toggle"
							aria-label="Close left sidebar"
							title={titleWithShortcut("Close left sidebar", sidebarHint)}
							aria-expanded={expanded}
							aria-controls="project-sidebar"
							onClick={toggleProjects}
						>
							<PanelLeft size={16} strokeWidth={1.5} />
						</button>
					</div>
					<div className="sidebar-toolbar">
						<button
							type="button"
							className="sidebar-new-project"
							onClick={onAddProject}
						>
							<Plus size={16} strokeWidth={1.5} />
							New project
						</button>
					</div>
					{onOpenMemory ? (
						<nav className="sidebar-nav" aria-label="Workspace">
							{onOpenWorkItems
								? (
										[
											["issues", "Issues", CircleDot],
											["pull-requests", "Pull requests", GitPullRequest],
										] as const
									).map(([kind, label, Icon]) => {
										const waiting =
											kind === "issues"
												? (waitingOnYou?.issues ?? 0)
												: (waitingOnYou?.pullRequests ?? 0);
										return (
											<button
												key={kind}
												type="button"
												className="sidebar-nav-item"
												aria-current={
													workItemsActive === kind ? "page" : undefined
												}
												onPointerEnter={onWorkItemsIntent}
												onFocus={onWorkItemsIntent}
												onClick={() => onOpenWorkItems(kind)}
											>
												<Icon size={16} strokeWidth={1.5} />
												{label}
												{waiting ? (
													<span
														className="sidebar-nav-badge"
														role="img"
														aria-label={`${waiting} waiting on you`}
														title="Waiting on you"
													>
														{waiting > 99 ? "99+" : waiting}
													</span>
												) : null}
											</button>
										);
									})
								: null}
							<button
								type="button"
								className="sidebar-nav-item"
								aria-current={memoryActive ? "page" : undefined}
								onPointerEnter={onMemoryIntent}
								onFocus={onMemoryIntent}
								onClick={onOpenMemory}
							>
								<BookMarked size={16} strokeWidth={1.5} />
								Memory
							</button>
						</nav>
					) : null}
					{projects.length ? (
						<div className="sidebar-y-sections">
							{y2Section(yRows, yPending)}
							{threadsSection()}
						</div>
					) : null}
					{projects.length || projectsLoading ? null : (
						<p className="sidebar-empty">No repositories connected.</p>
					)}
					{onOpenSettings ? (
						<SidebarAccountButton onOpen={onOpenSettings} initial={account} />
					) : null}
				</aside>
				{hydrated ? null : (
					// Runs as the server's HTML parses, before the rail below paints.
					<script
						// biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no user input.
						dangerouslySetInnerHTML={{ __html: FIRST_PAINT_ROWS_SCRIPT }}
						suppressHydrationWarning
					/>
				)}
			</div>
		</TooltipPrimitive.Provider>
	);
}

function SidebarAccountButton({
	onOpen,
	initial,
}: {
	onOpen: () => void;
	initial?: SidebarAccount;
}) {
	const account = useQuery({
		queryKey: ["account"],
		queryFn: () =>
			requestJson<{
				user: {
					name?: string | null;
					email?: string | null;
					image?: string | null;
				};
			}>("/api/account"),
	});
	const user = account.data?.user ?? initial ?? {};
	const name = accountDisplayName(user);
	const settingsHint = useShortcutHint("openSettings");
	return (
		<button
			type="button"
			className="sidebar-account"
			aria-label={`Settings for ${name}`}
			title={titleWithShortcut("Settings", settingsHint)}
			onClick={onOpen}
		>
			{user.image ? (
				<img src={user.image} width={28} height={28} alt="" />
			) : (
				<span className="sidebar-account-initials" aria-hidden="true">
					{accountInitials(user)}
				</span>
			)}
			<span className="sidebar-account-copy">
				<span className="sidebar-account-name">{name}</span>
				<span className="sidebar-account-meta">Settings</span>
			</span>
		</button>
	);
}

/**
 * The row's one status on the right: an icon, an unread dot, or the relative
 * time. A working chat shows the spinner instead of a time; its tooltip
 * carries the one clock, the time it has been working.
 */
function SidebarChatStatusMark({
	status,
	label,
	age,
	onOpenPullRequest,
	askingAsDot = false,
	prInMeta = false,
}: {
	status: SidebarChatStatus;
	label: string | null;
	age: string | null;
	onOpenPullRequest?: () => void;
	/** Under Y²: waiting on the user reads as the badge's colour, a dot. */
	askingAsDot?: boolean;
	/** A Threads row shows its pull request on the second line: the time stays here. */
	prInMeta?: boolean;
}) {
	const time = age ? <span className="sidebar-chat-age">{age}</span> : null;
	switch (status.kind) {
		case "asking":
			if (askingAsDot)
				return (
					<span
						className="sidebar-chat-needs-you"
						role="img"
						aria-label={label ?? undefined}
					/>
				);
			return (
				<span
					className="sidebar-chat-status"
					data-status="asking"
					role="img"
					aria-label={label ?? undefined}
				>
					<MessageCircleQuestion size={14} strokeWidth={2} aria-hidden="true" />
				</span>
			);
		case "setup":
			return (
				<span
					className="sidebar-chat-status"
					data-status="setup"
					role="img"
					aria-label={label ?? undefined}
				>
					<Clock3 size={14} strokeWidth={2} aria-hidden="true" />
				</span>
			);
		case "failed":
			return (
				<span
					className="sidebar-chat-status"
					data-status="failed"
					role="img"
					aria-label={label ?? undefined}
				>
					<TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
				</span>
			);
		case "pr":
			if (prInMeta) return time;
			return (
				<SidebarChatPr
					pr={status.pr}
					label={label}
					onOpen={onOpenPullRequest}
				/>
			);
		case "unread":
			return (
				<span
					className="sidebar-chat-unread"
					role="img"
					aria-label={label ?? undefined}
				/>
			);
		case "working":
			return (
				<span className="sidebar-chat-status" data-status="working">
					<MatrixDotLoader className="sidebar-chat-working" />
				</span>
			);
		case "idle":
			return time;
	}
}

function SidebarChatPr({
	pr,
	label,
	onOpen,
	hashed = false,
}: {
	pr: SidebarPullRequest;
	label: string | null;
	onOpen?: () => void;
	/** Shown as "#105" (a Threads row's badge) rather than "105". */
	hashed?: boolean;
}) {
	const Icon = {
		open: GitPullRequest,
		draft: GitPullRequestDraft,
		merged: GitMerge,
		closed: GitPullRequestClosed,
	}[pr.state];
	return (
		<a
			className="sidebar-chat-status sidebar-chat-pr"
			data-pr={pr.state}
			href={pr.url}
			target="_blank"
			rel="noreferrer"
			aria-label={label ?? undefined}
			onClick={(event) => {
				event.stopPropagation();
				// A plain click opens ytimesy's own review; a modified click
				// (new tab, new window) still goes to GitHub.
				if (
					!onOpen ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.button !== 0
				)
					return;
				event.preventDefault();
				onOpen();
			}}
		>
			<Icon size={14} strokeWidth={2} aria-hidden="true" />
			<span aria-hidden="true">{hashed ? `#${pr.number}` : pr.number}</span>
			{pr.checks === "passed" ? (
				<Check
					className="sidebar-chat-check"
					data-checks="passed"
					size={11}
					strokeWidth={2.6}
					aria-hidden="true"
				/>
			) : pr.checks === "failed" ? (
				<X
					className="sidebar-chat-check"
					data-checks="failed"
					size={11}
					strokeWidth={2.6}
					aria-hidden="true"
				/>
			) : null}
		</a>
	);
}

/** "Working · 1m 12s", ticking each second while the tooltip is open. */
function LiveStatusLabel({ status }: { status: SidebarChatStatus }) {
	const [nowMs, setNowMs] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	return <>{sidebarChatStatusLabel(status, nowMs)}</>;
}

/** localStorage can be missing or throw (private mode, blocked site data). */
function readStorage(key: string): string | null {
	if (typeof window === "undefined") return null;
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string) {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// The marker only lives for this page then.
	}
}
