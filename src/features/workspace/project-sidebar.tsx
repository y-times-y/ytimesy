import { useQuery } from "@tanstack/react-query";
import {
	Archive,
	ArrowUpDown,
	BookMarked,
	Check,
	ChevronRight,
	CircleDot,
	Clock3,
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
import { DropdownMenu, Tooltip as TooltipPrimitive } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Wordmark } from "#/components/brand/wordmark";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { titleWithShortcut } from "#/domain/keyboard-shortcuts";
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
	chatsWithPinnedFirst,
	collapsedProjectStorageValue,
	compactRelativeAge,
	newChatIsActive,
	type ProjectChats,
	parseSeenChatKeys,
	parseSeenSince,
	pinnedChatStorageValue,
	projectColor,
	projectFolderIsExpanded,
	projectsByRecentActivity,
	recentSections,
	SIDEBAR_COLLAPSED_PROJECTS_KEY,
	SIDEBAR_PINNED_CHATS_KEY,
	SIDEBAR_SORT_KEY,
	type SidebarChat,
	type SidebarSort,
	type SidebarStatusGroup,
	seenChatStorageValue,
	sidebarChatIsRunning,
	sidebarChatSeenKey,
	sidebarChatsEmptyCopy,
	sidebarStatusGroup,
	sidebarStatusSections,
	toggleCollapsedProjectIds,
	togglePinnedChatIds,
	trimmedSeenChatKeys,
	withProjectExpanded,
} from "#/domain/sidebar-chats";
import {
	SIDEBAR_COLLAPSED_Y2_KEY,
	type Y2ThreadTree,
	y2NeedsYouLabel,
	y2ThreadTree,
} from "#/domain/sidebar-tree";
import {
	accountDisplayName,
	accountInitials,
} from "#/domain/workspace-settings";
import {
	dropFirstPaintStyles,
	FIRST_PAINT_ROWS_SCRIPT,
	useFirstPaint,
} from "../app/first-paint";
import { useShortcutHint } from "../app/keyboard-shortcuts";
import { requestJson } from "../projects/api";
import { YSquaredMark } from "./y-squared-mark";

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

/** Recent's chat sections below the Y² group: Y projects' threads, and plain chats. */
type RecentSection = "y" | "plain";

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
	const [sortMenuOpen, setSortMenuOpen] = useState(false);
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
	const [collapsedProjectIds, setCollapsedProjectIds] = useState(
		firstPaint.choices.collapsedProjectIds,
	);
	const [pinnedChatIds, setPinnedChatIds] = useState(
		firstPaint.choices.pinnedChatIds,
	);
	const [collapsedY2Ids, setCollapsedY2Ids] = useState(
		firstPaint.choices.collapsedY2ProjectIds,
	);
	const [y2ThreadsExpanded, setY2ThreadsExpanded] = useState(false);
	// Only a fold the user opens animates in, never the page's first paint.
	const [y2Toggled, setY2Toggled] = useState(false);
	const [sort, setSort] = useState(firstPaint.choices.sidebarSort);
	// Until hydrated this renders the server's markup: both sort views, no
	// pins, folds or unread marks. The first-paint script shows the saved
	// choices meanwhile (src/features/app/first-paint.ts).
	const hydrated = firstPaint.hydrated;
	const shownSort = hydrated ? sort : null;
	const shownPinnedIds = hydrated ? pinnedChatIds : [];
	const shownCollapsedIds = hydrated ? collapsedProjectIds : [];
	const shownCollapsedY2Ids = hydrated ? collapsedY2Ids : [];
	const shownSeenKeys = hydrated ? seenKeys : [];
	const shownSeenSinceMs = hydrated ? seenSinceMs : null;
	const firstPaintView = (view: SidebarSort) => (hydrated ? undefined : view);
	// The open project's chats are the freshest list; the others come from projectChats.
	const groups = projects.map((project) => ({
		project,
		chats:
			project.id === selectedProjectId
				? chats
				: (projectChats.find((group) => group.project.id === project.id)
						?.chats ?? []),
	}));
	const recent = recentSections(groups, shownPinnedIds);
	const [yDoneExpanded, setYDoneExpanded] = useState(false);
	const [plainDoneExpanded, setPlainDoneExpanded] = useState(false);
	const orderedProjects = projectsByRecentActivity(projects, groups);
	function chooseSort(next: SidebarSort) {
		setSort(next);
		writeStorage(SIDEBAR_SORT_KEY, next);
	}
	const selected = projects.find((project) => project.id === selectedProjectId);
	const emptyCopy = sidebarChatsEmptyCopy({
		loading: projectsLoading,
		projectSelected: Boolean(selected),
	});
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

	function persistCollapsed(next: readonly string[]) {
		setCollapsedProjectIds(next);
		writeStorage(
			SIDEBAR_COLLAPSED_PROJECTS_KEY,
			collapsedProjectStorageValue(next),
		);
	}

	function toggleY2Threads(projectId: string) {
		const next = toggleCollapsedProjectIds(collapsedY2Ids, projectId);
		setCollapsedY2Ids(next);
		setY2Toggled(true);
		writeStorage(SIDEBAR_COLLAPSED_Y2_KEY, collapsedProjectStorageValue(next));
	}

	function persistPinned(next: readonly string[]) {
		setPinnedChatIds(next);
		writeStorage(SIDEBAR_PINNED_CHATS_KEY, pinnedChatStorageValue(next));
	}

	function openProject(projectId: string) {
		if (projectId !== selectedProjectId) onSelectProject(projectId);
		persistCollapsed(withProjectExpanded(collapsedProjectIds, projectId));
	}

	function toggleProjectFolder(projectId: string) {
		if (projectId !== selectedProjectId) {
			openProject(projectId);
			return;
		}
		persistCollapsed(toggleCollapsedProjectIds(collapsedProjectIds, projectId));
	}

	/** The open project's chats: a Y² tree in a Y project, else a flat list. */
	function projectChatList(project: Project) {
		if (chats.length === 0) return <p className="sidebar-empty">{emptyCopy}</p>;
		const tree = y2ThreadTree({
			chats,
			pinnedIds: shownPinnedIds,
			selectedChatId,
			statusOf: chatStatus,
			expanded: y2ThreadsExpanded,
			keepFolded: !hydrated,
		});
		return (
			<ul className="sidebar-chats">
				{tree
					? y2Tree(project, tree)
					: chatsWithPinnedFirst(chats, shownPinnedIds).map((chat) =>
							chatRow(chat),
						)}
			</ul>
		);
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

	function statusSection(
		section: RecentSection,
		group: SidebarStatusGroup,
		label: string,
		rows: readonly { chat: SidebarChat; project: Project }[],
		total: number,
		/** Before hydration every Done row renders; these past the fold start hidden. */
		hiddenFrom = Number.POSITIVE_INFINITY,
	) {
		if (!total) return null;
		return (
			<li
				key={`${section}-${group}`}
				className="sidebar-status-group"
				data-group={group}
				data-section={section}
			>
				<h3 className="sidebar-status-heading">
					<span>{label}</span>
					<span className="sidebar-status-count">{total}</span>
				</h3>
				<ul className="sidebar-chats">
					{rows.map(({ chat, project }, index) =>
						chatRow(chat, { project, pastFold: index >= hiddenFrom }),
					)}
				</ul>
			</li>
		);
	}

	/**
	 * One Recent section's chats by status (Needs you, Working, Done folded
	 * after a few). Before hydration every Done row renders, so the rows script
	 * can show a saved pin past the fold (it folds each section on its own).
	 */
	function statusBlock(
		section: RecentSection,
		rows: readonly { chat: SidebarChat; project: Project }[],
		expanded: boolean,
		onShowMore: () => void,
	) {
		const groupOf = (row: { chat: SidebarChat }) => chatStatus(row.chat);
		const sections = sidebarStatusSections(rows, groupOf, expanded);
		const firstPaintDone = hydrated
			? undefined
			: sidebarStatusSections(rows, groupOf, true).done;
		return (
			<>
				{statusSection(
					section,
					"needs-you",
					"Needs you",
					sections.needsYou,
					sections.needsYou.length,
				)}
				{statusSection(
					section,
					"working",
					"Working",
					sections.working,
					sections.working.length,
				)}
				{firstPaintDone
					? statusSection(
							section,
							"done",
							"Done",
							firstPaintDone,
							sections.doneTotal,
							sections.done.length,
						)
					: statusSection(
							section,
							"done",
							"Done",
							sections.done,
							sections.doneTotal,
						)}
				{sections.doneHidden ? (
					<li>
						<button
							type="button"
							className="sidebar-show-more"
							onClick={onShowMore}
						>
							Show {sections.doneHidden} more
						</button>
					</li>
				) : null}
			</>
		);
	}

	/** A Recent section's label ("Y", "Chats"): the Y² group's heading style, a divider above. */
	function sectionLabel(section: RecentSection, label: string) {
		return (
			<li
				key={`label-${section}`}
				className="sidebar-section-label"
				data-section-label={section}
			>
				<h3 className="sidebar-status-heading sidebar-y2-heading">
					<span>{label}</span>
				</h3>
			</li>
		);
	}

	/**
	 * Recent's Y² group, above the status groups: one row per Y project, so a
	 * Y² that waits on the person shows here once (not again under Needs you).
	 */
	function y2Section(rows: readonly { chat: SidebarChat; project: Project }[]) {
		if (!rows.length) return null;
		return (
			<li key="y2" className="sidebar-status-group" data-group="y2">
				<h3 className="sidebar-status-heading sidebar-y2-heading">
					<YSquaredMark size={16} />
					<span>Y²</span>
					<span className="sidebar-status-count">{rows.length}</span>
				</h3>
				<ul className="sidebar-chats">
					{rows.map(({ chat, project }) => chatRow(chat, { project }))}
				</ul>
			</li>
		);
	}

	/**
	 * The project's Y² chat heading its threads. Before hydration the branch
	 * renders open with every thread; the first-paint sheet folds what this
	 * browser saved (--y2-branch, data-done-overflow).
	 */
	function y2Tree(project: Project, tree: Y2ThreadTree<SidebarChat>) {
		const head = tree.head;
		const selected = head.id === selectedChatId;
		const open = !shownCollapsedY2Ids.includes(project.id);
		const shown = rowStatus(head, {
			keys: shownSeenKeys,
			sinceMs: shownSeenSinceMs,
		});
		const branchId = `sidebar-y2-branch-${project.id}`;
		const needsYou = tree.needsYouCount;
		const hasThreads = tree.threads.length > 0;
		return (
			<li
				key={head.id}
				className="sidebar-y2"
				data-project-id={project.id}
				data-open={open}
				data-toggled={y2Toggled ? "true" : undefined}
			>
				<div className="sidebar-y2-section" data-section="y2">
					<h3 className="sidebar-status-heading sidebar-y2-heading sidebar-y2-label">
						<YSquaredMark size={16} />
						<span>Y²</span>
					</h3>
					<div
						className="sidebar-chat-row sidebar-y2-row"
						data-chat-id={head.id}
						data-selected={selected}
						data-role="y2"
						{...firstPaintMarks(head)}
					>
						<button
							type="button"
							className="sidebar-chat"
							data-selected={selected}
							data-status={shown.kind}
							title="Y²: what is going on across this project's threads"
							aria-current={selected ? "page" : undefined}
							onPointerEnter={() => onChatIntent?.(head.id)}
							onFocus={() => onChatIntent?.(head.id)}
							onClick={() => onSelectChat?.(head.id)}
						>
							<span className="sidebar-chat-lead" aria-hidden="true">
								<YSquaredMark size={16} live={tree.workingCount > 0} />
							</span>
							<span className="sidebar-chat-title">Y²</span>
							{needsYou ? (
								<span className="sr-only">{y2NeedsYouLabel(needsYou)}</span>
							) : null}
							{shown.kind === "working" ? (
								<span className="sr-only">Working</span>
							) : null}
						</button>
						<div className="sidebar-chat-trailing">
							{shown.kind === "working" || shown.kind === "unread" ? (
								<SidebarChatStatusMark
									status={shown}
									label={sidebarChatStatusLabel(shown, nowMs)}
									age={null}
								/>
							) : null}
						</div>
					</div>
				</div>
				{hasThreads ? (
					<div
						className="sidebar-y2-section sidebar-y2-threads-section"
						data-section="y"
					>
						<div className="sidebar-status-heading sidebar-y2-heading sidebar-y2-label">
							<h3 className="sidebar-y2-label-text">Y</h3>
							<div className="sidebar-y2-label-trailing">
								<button
									type="button"
									className="sidebar-y2-toggle"
									aria-label={
										open ? "Collapse Y² threads" : "Expand Y² threads"
									}
									title={open ? "Collapse threads" : "Expand threads"}
									aria-expanded={open}
									aria-controls={open ? branchId : undefined}
									onClick={() => toggleY2Threads(project.id)}
								>
									<ChevronRight
										className="sidebar-y2-chevron"
										size={14}
										strokeWidth={1.5}
									/>
								</button>
								{needsYou ? (
									<span className="sidebar-y2-count" aria-hidden="true">
										{needsYou}
									</span>
								) : null}
							</div>
						</div>
						{open ? (
							<div className="sidebar-y2-branch" id={branchId}>
								<ul
									className="sidebar-chats sidebar-y2-threads"
									aria-label="Threads"
								>
									{tree.threads.map((thread) =>
										chatRow(thread.chat, {
											pastFold: thread.pastFold,
											foldable: thread.foldable,
											nested: true,
										}),
									)}
								</ul>
								{tree.overflowCount ? (
									<button
										type="button"
										className="sidebar-show-more sidebar-y2-more"
										aria-expanded={y2ThreadsExpanded}
										onClick={() => setY2ThreadsExpanded((value) => !value)}
									>
										{y2ThreadsExpanded
											? "Show fewer"
											: `Show ${tree.overflowCount} more`}
									</button>
								) : null}
							</div>
						) : null}
					</div>
				) : null}
			</li>
		);
	}

	function chatRow(
		chat: SidebarChat,
		{
			project,
			pastFold = false,
			foldable = false,
			nested = false,
		}: {
			/** In Recent: the project the chat belongs to. */
			project?: Project;
			pastFold?: boolean;
			/** Under Y², before hydration: the rows script may fold it. */
			foldable?: boolean;
			/** A thread under Y²: a waiting thread shows a dot. */
			nested?: boolean;
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
		// In Recent, a project's Y² chat reads as the project's overview: the Y²
		// mark in the icon column, the project's name as its title.
		const y2OfProject = chat.role === "y2" && project ? project : null;
		const row = (
			<li
				key={chat.id}
				className="sidebar-chat-row"
				data-chat-id={chat.id}
				data-selected={chat.id === selectedChatId}
				data-pinned={pinned ? "true" : undefined}
				data-role={chat.role}
				data-done-overflow={pastFold ? "true" : undefined}
				data-foldable={foldable && !hydrated ? "true" : undefined}
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
							: y2OfProject
								? `Y² · ${projectName}`
								: [chat.title, projectName].filter(Boolean).join(" · ")
					}
					aria-current={chat.id === selectedChatId ? "page" : undefined}
					onPointerEnter={() => onChatIntent?.(chat.id)}
					onFocus={() => onChatIntent?.(chat.id)}
					onClick={() =>
						project && project.id !== selectedProjectId && onSelectChatInProject
							? onSelectChatInProject(project.id, chat.id)
							: onSelectChat?.(chat.id)
					}
				>
					{/* The icon column every sidebar row shares: in Recent, the
					    chat's project; under a project, empty so titles line up
					    with the project's name. */}
					<span className="sidebar-chat-lead" aria-hidden="true">
						{y2OfProject ? (
							<YSquaredMark size={16} live={chatRunning(chat)} />
						) : project ? (
							<span
								className="sidebar-project-dot"
								style={{ background: projectColor(project.id) }}
							/>
						) : null}
					</span>
					<span className="sidebar-chat-title">
						{y2OfProject ? projectName : chat.title}
					</span>
					{y2OfProject ? (
						<span className="sr-only">Y²</span>
					) : projectName ? (
						<span className="sr-only">{projectName}</span>
					) : null}
					{shown.kind === "working" ? (
						<span className="sr-only">Working</span>
					) : null}
				</button>
				<div className="sidebar-chat-trailing">
					{/* Y² is the project's own chat: always on top, and it stays while Y is on. */}
					{chat.role === "y2" ? null : (
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
					)}
					{onDeleteChat && chat.role !== "y2" ? (
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
						askingAsDot={nested}
					/>
				</div>
			</li>
		);
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
						<div className="sidebar-list-header">
							<span>Chats</span>
							<DropdownMenu.Root
								open={sortMenuOpen}
								onOpenChange={(open) => {
									setSortMenuOpen(open);
								}}
								modal={false}
							>
								<DropdownMenu.Trigger asChild>
									<button
										type="button"
										className="sidebar-sort-button"
										aria-label={`Sort chats: ${shownSort === "recent" ? "Recent" : "Projects"}`}
										title="Sort chats"
									>
										<ArrowUpDown size={14} strokeWidth={1.5} />
									</button>
								</DropdownMenu.Trigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Content
										className="recovery-menu sidebar-sort-menu"
										align="end"
										sideOffset={4}
									>
										<DropdownMenu.RadioGroup
											value={sort}
											onValueChange={(value) =>
												chooseSort(value === "recent" ? "recent" : "projects")
											}
										>
											{(["recent", "projects"] as const).map((value) => (
												<DropdownMenu.RadioItem key={value} value={value}>
													<span className="menu-row-label">
														{value === "recent" ? "Recent" : "Projects"}
													</span>
													<span className="menu-row-check">
														<DropdownMenu.ItemIndicator>
															<Check size={14} strokeWidth={1.5} />
														</DropdownMenu.ItemIndicator>
													</span>
												</DropdownMenu.RadioItem>
											))}
										</DropdownMenu.RadioGroup>
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						</div>
					) : null}
					{projects.length && shownSort !== "projects" ? (
						recent.y2.length || recent.y.length || recent.plain.length ? (
							<ul
								className="sidebar-recent sidebar-status-groups"
								data-sort-view={firstPaintView("recent")}
							>
								{y2Section(recent.y2)}
								{recent.y.length ? (
									<>
										{sectionLabel("y", "Y")}
										{statusBlock("y", recent.y, yDoneExpanded, () =>
											setYDoneExpanded(true),
										)}
									</>
								) : null}
								{recent.plain.length ? (
									<>
										{recent.y.length ? sectionLabel("plain", "Chats") : null}
										{statusBlock("plain", recent.plain, plainDoneExpanded, () =>
											setPlainDoneExpanded(true),
										)}
									</>
								) : null}
							</ul>
						) : (
							<p
								className="sidebar-empty"
								data-sort-view={firstPaintView("recent")}
							>
								{emptyCopy}
							</p>
						)
					) : null}
					{projects.length && shownSort !== "recent" ? (
						<ul
							className="sidebar-projects"
							data-sort-view={firstPaintView("projects")}
						>
							{orderedProjects.map((project) => {
								const selected = project.id === selectedProjectId;
								const open = projectFolderIsExpanded({
									projectId: project.id,
									selectedProjectId,
									collapsedIds: shownCollapsedIds,
								});
								return (
									<li
										key={project.id}
										className="sidebar-project"
										data-project-id={project.id}
									>
										<div
											className="sidebar-folder-row"
											data-selected={selected}
											data-open={open}
										>
											<button
												type="button"
												className="sidebar-folder"
												aria-current={selected ? "page" : undefined}
												aria-expanded={open}
												onPointerEnter={
													selected
														? undefined
														: () => onProjectIntent?.(project.id)
												}
												onFocus={
													selected
														? undefined
														: () => onProjectIntent?.(project.id)
												}
												onClick={() =>
													selected
														? toggleProjectFolder(project.id)
														: openProject(project.id)
												}
											>
												<span
													className="sidebar-project-dot"
													style={{ background: projectColor(project.id) }}
													aria-hidden="true"
												/>
												<span>{projectDisplayName(project)}</span>
											</button>
											<div className="sidebar-folder-actions">
												{onDeleteProject ? (
													<button
														type="button"
														className="sidebar-folder-remove"
														aria-label={`Archive ${projectDisplayName(project)}`}
														title="Archive project"
														onClick={(event) => {
															event.stopPropagation();
															onDeleteProject(project.id);
														}}
													>
														<Archive size={14} strokeWidth={1.5} />
													</button>
												) : null}
												<button
													type="button"
													className="sidebar-folder-toggle"
													aria-label={
														open
															? `Collapse ${projectDisplayName(project)}`
															: `Expand ${projectDisplayName(project)}`
													}
													aria-expanded={open}
													onClick={() => toggleProjectFolder(project.id)}
												>
													<ChevronRight size={14} strokeWidth={1.5} />
												</button>
												<button
													type="button"
													className="sidebar-folder-add"
													aria-label={`New chat in ${projectDisplayName(project)}`}
													title={titleWithShortcut("New chat", newChatHint)}
													data-active={
														selected && newChatActive ? "true" : undefined
													}
													onClick={() => {
														persistCollapsed(
															withProjectExpanded(
																collapsedProjectIds,
																project.id,
															),
														);
														onNewChat(project.id);
													}}
												>
													<Plus size={14} strokeWidth={1.5} />
												</button>
											</div>
										</div>
										{open ? projectChatList(project) : null}
									</li>
								);
							})}
						</ul>
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
}: {
	status: SidebarChatStatus;
	label: string | null;
	age: string | null;
	onOpenPullRequest?: () => void;
	/** Under Y²: waiting on the user reads as the badge's colour, a dot. */
	askingAsDot?: boolean;
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
}: {
	pr: SidebarPullRequest;
	label: string | null;
	onOpen?: () => void;
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
			<span aria-hidden="true">{pr.number}</span>
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
