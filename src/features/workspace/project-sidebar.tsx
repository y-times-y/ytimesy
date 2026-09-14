import { PanelLeft, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type PublicGitHubProject,
	type PublicProjectPicker,
	projectPickerLabel,
} from "#/domain/github-project";
import {
	newChatIsActive,
	type SidebarChat,
	sidebarChatsEmptyCopy,
} from "#/domain/sidebar-chats";

interface ProjectSidebarProps {
	expanded: boolean;
	onToggle: () => void;
	picker: PublicProjectPicker | null;
	chats: readonly SidebarChat[];
	onNewChat: () => void;
	onFocusProject: () => void;
}

export function ProjectSidebar({
	expanded,
	onToggle,
	picker,
	chats,
	onNewChat,
	onFocusProject,
}: ProjectSidebarProps) {
	const collapseButton = useRef<HTMLButtonElement>(null);
	const railLogo = useRef<HTMLButtonElement>(null);
	const [hovered, setHovered] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const visible = expanded || hovered;
	const selected = selectedProject(picker);
	const projectLabel = selected
		? projectPickerLabel(selected, picker?.projects ?? [])
		: null;
	const emptyCopy = sidebarChatsEmptyCopy({
		loading: picker === null,
		projectSelected: Boolean(selected),
	});
	const newChatActive = newChatIsActive({
		projectSelected: Boolean(selected),
		hasUserMessage: chats.length > 0,
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
				aria-label="Chats"
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
				<button
					type="button"
					className="sidebar-chat"
					data-selected={projectLabel ? true : undefined}
					onClick={onFocusProject}
				>
					{projectLabel ??
						(picker === null ? "Loading repository…" : "Select a repository")}
				</button>
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
						{chats.map((chat) => (
							<li key={chat.id}>
								<button type="button" className="sidebar-chat" data-selected>
									{chat.title}
								</button>
							</li>
						))}
					</ul>
				)}
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
					onClick={toggleProjects}
				>
					<img
						className="brand-mark"
						src="/brand/mark.svg"
						width={28}
						height={28}
						alt=""
					/>
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

function selectedProject(
	picker: PublicProjectPicker | null,
): PublicGitHubProject | null {
	if (!picker?.selectedProjectId) return null;
	return (
		picker.projects.find(
			(project) => project.projectId === picker.selectedProjectId,
		) ?? null
	);
}
