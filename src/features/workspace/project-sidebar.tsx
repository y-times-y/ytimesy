import { Archive, PanelLeft, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project } from "#/domain/projects";
import type { SessionTurnStatus } from "#/domain/session-item";
import {
	newChatIsActive,
	type SidebarChat,
	sidebarChatIsRunning,
	sidebarChatsEmptyCopy,
	sidebarHasRunningChat,
} from "#/domain/sidebar-chats";

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
	openSideTurnStatus?: SessionTurnStatus;
	hasUserMessage?: boolean;
	onSelectChat?: (id: string) => void;
	onNewChat: () => void;
	onDeleteChat?: (id: string) => void;
	onOpenSettings?: () => void;
	onSignOut: () => void;
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
	openSideTurnStatus,
	hasUserMessage = false,
	onSelectChat,
	onNewChat,
	onDeleteChat,
	onOpenSettings,
	onSignOut,
}: ProjectSidebarProps) {
	const collapseButton = useRef<HTMLButtonElement>(null);
	const railLogo = useRef<HTMLButtonElement>(null);
	const [hovered, setHovered] = useState(false);
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
	const hasRunningChat = sidebarHasRunningChat({
		chats,
		busyChatIds,
		openChatId: selectedChatId,
		openTurnStatus,
		openSideTurnStatus,
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

	function toggleProjects() {
		cancelClose();
		setHovered(false);
		onToggle();
		requestAnimationFrame(() => {
			(expanded ? railLogo : collapseButton).current?.focus();
		});
	}

	return (
		<div
			className="project-sidebar-frame"
			data-peek={!expanded && hovered}
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
						type="button"
						className="panel-toggle"
						ref={collapseButton}
						aria-label={expanded ? "Collapse chats" : "Keep chats open"}
						title={expanded ? "Collapse chats" : "Keep chats open"}
						aria-expanded={expanded}
						aria-controls="project-sidebar"
						onClick={toggleProjects}
					>
						<PanelLeft size={16} />
					</button>
				</div>
				<div className="sidebar-section">
					<span>Projects</span>
					<button
						type="button"
						className="panel-toggle"
						aria-label="Add project"
						title="Add project"
						onClick={onAddProject}
					>
						<Plus size={16} />
					</button>
				</div>
				{projects.length ? (
					<ul className="project-list">
						{projects.map((project) => (
							<li key={project.id}>
								<button
									type="button"
									className="sidebar-chat"
									aria-current={
										project.id === selectedProjectId ? "page" : undefined
									}
									onClick={() => onSelectProject(project.id)}
								>
									{project.fullName}
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="sidebar-empty">
						{projectsLoading
							? "Loading repositories…"
							: "No repositories connected."}
					</p>
				)}
				<div className="sidebar-section">
					<span>Chats</span>
					<button
						type="button"
						className="panel-toggle"
						aria-label="New chat"
						title="New chat"
						data-active={newChatActive}
						onClick={onNewChat}
					>
						<Plus size={16} />
					</button>
				</div>
				{chats.length === 0 ? (
					<p className="sidebar-empty">{emptyCopy}</p>
				) : (
					<ul className="sidebar-chats">
						{chats.map((chat) => {
							const running = sidebarChatIsRunning({
								chatId: chat.id,
								turnStatus: chat.turnStatus,
								busyChatIds,
								openChatId: selectedChatId,
								openTurnStatus,
								openSideTurnStatus,
							});
							return (
								<li
									key={chat.id}
									className="sidebar-chat-row"
									data-selected={chat.id === selectedChatId}
								>
									<button
										type="button"
										className="sidebar-chat"
										data-selected={chat.id === selectedChatId}
										data-activity={running ? "running" : undefined}
										aria-current={
											chat.id === selectedChatId ? "page" : undefined
										}
										onClick={() => onSelectChat?.(chat.id)}
									>
										{chat.title}
										{running ? <span className="sr-only">Running</span> : null}
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
								</li>
							);
						})}
					</ul>
				)}
				<div className="sidebar-account">
					{onOpenSettings ? (
						<button
							type="button"
							className="panel-toggle"
							aria-label="Settings"
							title="Settings"
							onClick={onOpenSettings}
						>
							<Settings size={16} />
							<span>Settings</span>
						</button>
					) : null}
					<button
						type="button"
						className="panel-toggle account-signout"
						onClick={onSignOut}
					>
						Sign out
					</button>
				</div>
			</aside>
			<nav
				className="sidebar-rail"
				aria-label="Chat shortcuts"
				inert={visible}
				aria-hidden={visible}
			>
				<button
					type="button"
					ref={railLogo}
					className="rail-brand"
					aria-label="Open chats"
					title="Open chats"
					aria-expanded={expanded}
					aria-controls="project-sidebar"
					data-activity={hasRunningChat ? "running" : undefined}
					onClick={toggleProjects}
				>
					<img
						className="brand-mark"
						src="/brand/mark.svg"
						width={28}
						height={28}
						alt=""
					/>
					{hasRunningChat ? (
						<span className="sr-only">A chat is running</span>
					) : null}
				</button>
				<button
					type="button"
					className="panel-toggle"
					aria-label="New chat"
					title="New chat"
					data-active={newChatActive}
					onClick={onNewChat}
				>
					<Plus size={16} />
				</button>
			</nav>
		</div>
	);
}
