import { PanelLeft, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Project } from "../../domain/projects";

interface ProjectSidebarProps {
	projects: Project[];
	selectedProjectId?: string;
	onSelectProject: (id: string) => void;
	expanded: boolean;
	onToggle: () => void;
	onAddProject: () => void;
}

export function ProjectSidebar({
	projects,
	selectedProjectId,
	onSelectProject,
	expanded,
	onToggle,
	onAddProject,
}: ProjectSidebarProps) {
	const collapseButton = useRef<HTMLButtonElement>(null);
	const railLogo = useRef<HTMLButtonElement>(null);
	const [hovered, setHovered] = useState(false);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const visible = expanded || hovered;

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
				aria-label="Close projects"
				tabIndex={-1}
				onClick={toggleProjects}
			/>
			<aside
				id="project-sidebar"
				className="project-sidebar"
				aria-label="Projects"
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
						aria-label={expanded ? "Collapse projects" : "Keep projects open"}
						title={expanded ? "Collapse projects" : "Keep projects open"}
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
					<p className="sidebar-empty">No repositories connected.</p>
				)}
			</aside>
			<nav
				className="sidebar-rail"
				aria-label="Project shortcuts"
				inert={visible}
				aria-hidden={visible}
			>
				<button
					type="button"
					ref={railLogo}
					className="rail-brand"
					aria-label="Open projects"
					title="Open projects"
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
					aria-label="Add project"
					title="Add project"
					onClick={onAddProject}
				>
					<Plus size={16} />
				</button>
			</nav>
		</div>
	);
}
