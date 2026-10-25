import { useQuery } from "@tanstack/react-query";
import {
	Archive,
	ArrowUpDown,
	BookMarked,
	Check,
	ChevronRight,
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
import {
	type ReactNode,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
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
	recentSidebarChats,
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
	sidebarHasAttentionChat,
	sidebarStatusGroup,
	sidebarStatusSections,
	toggleCollapsedProjectIds,
	togglePinnedChatIds,
	trimmedSeenChatKeys,
	withProjectExpanded,
} from "#/domain/sidebar-chats";
import {
	accountDisplayName,
	accountInitials,
} from "#/domain/workspace-settings";
import { dropFirstPaintStyles, useFirstPaint } from "../app/first-paint";
import { requestJson } from "../projects/api";

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
	onNewChat: (projectId?: string) => void;
	onDeleteChat?: (id: string) => void;
	onDeleteProject?: (id: string) => void;
	onOpenSettings?: () => void;
	/** Every project's chats, for the Recent list and ordering projects by activity. */
	projectChats?: readonly ProjectChats<Project>[];
	/** Opens a chat that may belong to another project (the Recent list). */
	onSelectChatInProject?: (projectId: string, chatId: string) => void;
	/** Opens the full-page Memory view (graph and list). */
	onOpenMemory?: () => void;
	memoryActive?: boolean;
	/** The pointer or focus reached a chat: it may open next. */
	onChatIntent?: (chatId: string) => void;
	/** The pointer or focus reached Memory: it may open next. */
	onMemoryIntent?: () => void;
	/** When the server rendered the page: relative times hydrate from it. */
	renderedAtMs?: number;
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
	onNewChat,
	onDeleteChat,
	onDeleteProject,
	onOpenSettings,
	projectChats = [],
	onSelectChatInProject,
	onOpenMemory,
	memoryActive = false,
	onChatIntent,
	onMemoryIntent,
	renderedAtMs,
}: ProjectSidebarProps) {
	const sidebarToggle = useRef<HTMLButtonElement>(null);
	const railLogo = useRef<HTMLButtonElement>(null);
	const mobileToggle = useRef<HTMLButtonElement>(null);
	const [hovered, setHovered] = useState(false);
	// The sort menu opens outside the frame; while it is open the peek stays.
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
	const [sort, setSort] = useState(firstPaint.choices.sidebarSort);
	// Until hydrated this renders the server's markup: both sort views, no
	// pins, folds or unread marks. The first-paint script shows the saved
	// choices meanwhile (src/features/app/first-paint.ts).
	const hydrated = firstPaint.hydrated;
	const shownSort = hydrated ? sort : null;
	const shownPinnedIds = hydrated ? pinnedChatIds : [];
	const shownCollapsedIds = hydrated ? collapsedProjectIds : [];
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
	const recentChats = recentSidebarChats(groups, shownPinnedIds);
	const [doneExpanded, setDoneExpanded] = useState(false);
	const orderedProjects = projectsByRecentActivity(projects, groups);
	function chooseSort(next: SidebarSort) {
		setSort(next);
		writeStorage(SIDEBAR_SORT_KEY, next);
	}
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const visible = expanded || hovered;
	const selected = projects.find((project) => project.id === selectedProjectId);
	const emptyCopy = sidebarChatsEmptyCopy({
		loading: projectsLoading,
		projectSelected: Boolean(selected),
	});
	const newChatActive = newChatIsActive({
		projectSelected: Boolean(selected),
		hasUserMessage,
	});
	const hasAttentionChat = sidebarHasAttentionChat({
		chats,
		selectedChatId,
		seenKeys: shownSeenKeys,
		busyChatIds,
		openTurnStatus,
		seenSinceMs: shownSeenSinceMs,
	});

	function cancelClose() {
		if (closeTimer.current !== null) clearTimeout(closeTimer.current);
	}

	useEffect(
		() => () => {
			if (closeTimer.current !== null) clearTimeout(closeTimer.current);
		},
		[],
	);

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

	function toggleProjects() {
		cancelClose();
		setHovered(false);
		onToggle();
		requestAnimationFrame(() => {
			const opener = railLogo.current?.getClientRects().length
				? railLogo
				: mobileToggle;
			(expanded ? opener : sidebarToggle).current?.focus();
		});
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
		});
	}

	function rowStatus(chat: SidebarChat): SidebarChatStatus {
		const running = chatRunning(chat);
		const selected = chat.id === selectedChatId;
		return sidebarChatStatus({
			running,
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
				seen: shownSeenKeys.includes(sidebarChatSeenKey(chat)),
				seenSinceMs: shownSeenSinceMs,
			}),
		});
	}

	function statusSection(
		group: SidebarStatusGroup,
		label: string,
		rows: readonly { chat: SidebarChat; project: Project }[],
		total: number,
	) {
		if (!total) return null;
		return (
			<li key={group} className="sidebar-status-group" data-group={group}>
				<h3 className="sidebar-status-heading">
					<span>{label}</span>
					<span className="sidebar-status-count">{total}</span>
				</h3>
				<ul className="sidebar-chats">
					{rows.map(({ chat, project }) => chatRow(chat, project))}
				</ul>
			</li>
		);
	}

	function chatRow(chat: SidebarChat, project?: Project) {
		const status = chatStatus(chat);
		const shown = rowStatus(chat);
		const label = sidebarChatStatusLabel(shown, nowMs);
		const age = compactRelativeAge(chat.updatedAt, nowMs);
		const pinned = shownPinnedIds.includes(chat.id);
		const projectName = project ? projectDisplayName(project) : null;
		const row = (
			<li
				key={chat.id}
				className="sidebar-chat-row"
				data-chat-id={chat.id}
				data-selected={chat.id === selectedChatId}
				data-pinned={pinned ? "true" : undefined}
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
						{project ? (
							<span
								className="sidebar-project-dot"
								style={{ background: projectColor(project.id) }}
							/>
						) : null}
					</span>
					<span className="sidebar-chat-title">{chat.title}</span>
					{projectName ? <span className="sr-only">{projectName}</span> : null}
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
							aria-label={`Remove ${chat.title}`}
							title="Remove chat"
							onClick={(event) => {
								event.stopPropagation();
								onDeleteChat(chat.id);
							}}
						>
							<Archive size={14} strokeWidth={1.5} />
						</button>
					) : null}
					<SidebarChatStatusMark status={shown} label={label} age={age} />
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
			<div
				className="project-sidebar-frame"
				data-peek={!expanded && (hovered || sortMenuOpen)}
				onPointerEnter={(event) => {
					if (
						event.pointerType !== "mouse" ||
						!window.matchMedia(
							"(hover: hover) and (min-width: 601px) and (min-height: 501px)",
						).matches
					)
						return;
					cancelClose();
					if (!expanded) setHovered(true);
				}}
				onPointerLeave={() => {
					cancelClose();
					closeTimer.current = setTimeout(() => setHovered(false), 140);
				}}
			>
				<button
					ref={mobileToggle}
					type="button"
					className="workspace-sidebar-toggle mobile-projects-toggle"
					aria-label={expanded ? "Close left sidebar" : "Open left sidebar"}
					title={expanded ? "Close left sidebar" : "Open left sidebar"}
					aria-expanded={expanded}
					aria-controls="project-sidebar"
					onClick={toggleProjects}
				>
					<PanelLeft size={16} strokeWidth={1.5} />
				</button>
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
					inert={!visible}
					aria-hidden={!visible}
					onKeyDown={(event) => {
						if (event.key === "Escape" && expanded) {
							event.preventDefault();
							toggleProjects();
						}
					}}
				>
					<div className="sidebar-brand-row">
						<a href="/" className="brand" aria-label="ytimesy home">
							<img
								className="brand-mark"
								src="/brand/mark.svg"
								width={28}
								height={28}
								alt=""
							/>
							<span className="brand-name">ytimesy</span>
						</a>
						<button
							ref={sidebarToggle}
							type="button"
							className="workspace-sidebar-toggle sidebar-brand-toggle"
							aria-label={expanded ? "Collapse chats" : "Keep chats open"}
							title={expanded ? "Collapse chats" : "Keep chats open"}
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
									// The pointer is back over the sidebar after a pick: keep it open.
									if (!open) setHovered(true);
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
						recentChats.length ? (
							<RecentSections
								sections={sidebarStatusSections(
									recentChats,
									(row) => chatStatus(row.chat),
									doneExpanded,
								)}
								render={statusSection}
								onShowMore={() => setDoneExpanded(true)}
								firstPaintView={firstPaintView("recent")}
							/>
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
														aria-label={`Remove ${projectDisplayName(project)}`}
														title="Remove project"
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
													title="New chat"
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
										{open ? (
											chats.length === 0 ? (
												<p className="sidebar-empty">{emptyCopy}</p>
											) : (
												<ul className="sidebar-chats">
													{chatsWithPinnedFirst(chats, shownPinnedIds).map(
														(chat) => chatRow(chat),
													)}
												</ul>
											)
										) : null}
									</li>
								);
							})}
						</ul>
					) : null}
					{projects.length || projectsLoading ? null : (
						<p className="sidebar-empty">No repositories connected.</p>
					)}
					{onOpenSettings ? (
						<SidebarAccountButton onOpen={onOpenSettings} />
					) : null}
				</aside>
				<nav
					className="sidebar-rail"
					aria-label="Chat shortcuts"
					inert={visible}
					aria-hidden={visible}
				>
					<button
						type="button"
						className="rail-brand"
						ref={railLogo}
						aria-label="Open chats"
						title="Open chats"
						aria-expanded={expanded}
						aria-controls="project-sidebar"
						data-activity={hasAttentionChat ? "attention" : undefined}
						onClick={toggleProjects}
					>
						<img
							className="brand-mark"
							src="/brand/mark.svg"
							width={28}
							height={28}
							alt=""
						/>
						{hasAttentionChat ? (
							<span className="sr-only">A chat needs attention</span>
						) : null}
					</button>
					<button
						type="button"
						className="panel-toggle"
						aria-label="New chat"
						title="New chat"
						data-active={newChatActive}
						onClick={() => onNewChat()}
					>
						<Plus size={16} strokeWidth={1.5} />
					</button>
					{onOpenMemory ? (
						<button
							type="button"
							className="panel-toggle"
							aria-label="Memory"
							title="Memory"
							data-active={memoryActive}
							onPointerEnter={onMemoryIntent}
							onFocus={onMemoryIntent}
							onClick={onOpenMemory}
						>
							<BookMarked size={16} strokeWidth={1.5} />
						</button>
					) : null}
				</nav>
			</div>
		</TooltipPrimitive.Provider>
	);
}

type StatusSections = ReturnType<
	typeof sidebarStatusSections<{ chat: SidebarChat; project: Project }>
>;

/** The Recent list by status: Needs you, Working, then Done (folded after a few). */
function RecentSections({
	sections,
	render,
	onShowMore,
	firstPaintView,
}: {
	sections: StatusSections;
	render: (
		group: SidebarStatusGroup,
		label: string,
		rows: StatusSections["done"],
		total: number,
	) => ReactNode;
	onShowMore: () => void;
	firstPaintView?: SidebarSort;
}) {
	return (
		<ul
			className="sidebar-recent sidebar-status-groups"
			data-sort-view={firstPaintView}
		>
			{render(
				"needs-you",
				"Needs you",
				sections.needsYou,
				sections.needsYou.length,
			)}
			{render("working", "Working", sections.working, sections.working.length)}
			{render("done", "Done", sections.done, sections.doneTotal)}
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
		</ul>
	);
}

function SidebarAccountButton({ onOpen }: { onOpen: () => void }) {
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
	const user = account.data?.user ?? {};
	const name = accountDisplayName(user);
	return (
		<button
			type="button"
			className="sidebar-account"
			aria-label={`Settings for ${name}`}
			title="Settings"
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

/** The row's one status on the right: an icon, an unread dot, or the relative time. */
function SidebarChatStatusMark({
	status,
	label,
	age,
}: {
	status: SidebarChatStatus;
	label: string | null;
	age: string | null;
}) {
	const time = age ? <span className="sidebar-chat-age">{age}</span> : null;
	switch (status.kind) {
		case "asking":
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
			return <SidebarChatPr pr={status.pr} label={label} />;
		case "unread":
			return (
				<span
					className="sidebar-chat-unread"
					role="img"
					aria-label={label ?? undefined}
				/>
			);
		case "working":
		case "idle":
			return time;
	}
}

function SidebarChatPr({
	pr,
	label,
}: {
	pr: SidebarPullRequest;
	label: string | null;
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
			onClick={(event) => event.stopPropagation()}
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
