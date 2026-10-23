import {
	AppWindow,
	BookMarked,
	Check,
	Files,
	FolderTree,
	GitPullRequest,
	ListTodo,
	Monitor,
	Plus,
	SquareTerminal,
	X,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import type { FileChangeEntry } from "#/domain/session-item";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { DesktopInspector } from "./desktop-inspector";
import { DiffInspector } from "./diff-inspector";
import { FilesInspector } from "./files-inspector";
import { MemoryInspector } from "./memory-inspector";
import { PreviewInspector } from "./preview-inspector";
import {
	PullRequestInspector,
	type PullRequestRepository,
} from "./pull-request-inspector";
import { TerminalInspector } from "./terminal-inspector";

export type ToolsView =
	| "files"
	| "diff"
	| "pr"
	| "terminal"
	| "desktop"
	| "preview"
	| "memory";
export type InspectorView = ToolsView | "overview";

const views = {
	files: {
		label: "Files",
		icon: FolderTree,
		title: "No files yet.",
		description: "The workspace tree will appear here.",
	},
	diff: {
		label: "Diff",
		icon: Files,
		title: "No changes yet.",
		description: "Changes from this turn will appear here.",
	},
	pr: {
		label: "Pull request",
		icon: GitPullRequest,
		title: "No repository connected.",
		description:
			"Connect this project to a GitHub repository to review its pull requests here.",
	},
	terminal: {
		label: "Terminal",
		icon: SquareTerminal,
		title: "No terminal connected.",
		description: "Start a workspace to use the terminal.",
	},
	desktop: {
		label: "Desktop",
		icon: Monitor,
		title: "Shared desktop",
		description:
			"This is the desktop the agent uses for QA. You watch and control the same screen.",
	},
	preview: {
		label: "Preview",
		icon: AppWindow,
		title: "Preview",
		description: "Open the apps running in this chat's workspace.",
	},
	memory: {
		label: "Memory",
		icon: BookMarked,
		title: "Memory",
		description: "What the agent remembers about you across chats.",
	},
} as const;

export function WorkspaceInspector({
	collapsed,
	activeView,
	onActiveViewChange,
	fileChanges = [],
	selectedFilePath,
	onSelectFilePath,
	desktop,
	desktopBusy,
	onStartDesktop,
	projectId,
	sessionId,
	overview,
	pullRequest,
	onOpenChat,
	memoryFocus,
}: {
	/** A memory file to show when the Memory tab opens from a chat marker. */
	memoryFocus?: { path: string };
	collapsed: boolean;
	activeView: InspectorView;
	onActiveViewChange: (view: InspectorView) => void;
	fileChanges?: readonly FileChangeEntry[];
	selectedFilePath?: string;
	onSelectFilePath?: (path: string) => void;
	desktop: WorkspaceDesktop;
	desktopBusy: boolean;
	onStartDesktop: () => void;
	projectId?: string;
	sessionId?: string;
	overview: ReactNode;
	pullRequest?: PullRequestRepository;
	/** Opens a chat linked from memory; false when it is not in this project's list. */
	onOpenChat?: (chatId: string) => boolean;
}) {
	const [openedViews, setOpenedViews] = useState<ToolsView[]>([]);
	useEffect(() => {
		if (activeView !== "overview")
			setOpenedViews((current) =>
				current.includes(activeView) ? current : [...current, activeView],
			);
	}, [activeView]);
	const currentView = activeView === "overview" ? null : views[activeView];
	return (
		<aside
			id="workspace-inspector"
			className="workspace-inspector"
			aria-label="Workspace inspector"
			inert={collapsed}
			aria-hidden={collapsed}
		>
			<div className="inspector-toolbar">
				<div className="inspector-tabs">
					<button
						type="button"
						aria-pressed={activeView === "overview"}
						onClick={() => onActiveViewChange("overview")}
					>
						<ListTodo size={16} />
						Overview
					</button>
					{openedViews.map((view) => (
						<div
							className="inspector-side-tab"
							key={view}
							data-active={activeView === view}
						>
							<button
								type="button"
								key={view}
								aria-pressed={activeView === view}
								onClick={() => onActiveViewChange(view)}
							>
								{views[view].label}
							</button>
							<button
								type="button"
								className="inspector-side-close"
								aria-label={`Close ${views[view].label}`}
								onClick={() => {
									setOpenedViews((current) =>
										current.filter((item) => item !== view),
									);
									if (activeView === view) onActiveViewChange("overview");
								}}
							>
								<X size={14} />
							</button>
						</div>
					))}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger asChild>
							<button
								type="button"
								className="inspector-new-tab"
								aria-label="Open workspace view"
							>
								<Plus size={16} />
							</button>
						</DropdownMenu.Trigger>
						<DropdownMenu.Portal>
							<DropdownMenu.Content
								className="recovery-menu inspector-view-menu"
								sideOffset={6}
								align="start"
							>
								{(Object.keys(views) as ToolsView[]).map((view) => {
									const Icon = views[view].icon;
									const active = activeView === view;
									return (
										<DropdownMenu.Item
											key={view}
											data-selected={active || undefined}
											onSelect={() => onActiveViewChange(view)}
										>
											<Icon size={16} strokeWidth={1.5} aria-hidden="true" />
											<span className="menu-row-label">
												{views[view].label}
											</span>
											<span className="menu-row-check">
												{active ? (
													<Check
														size={14}
														strokeWidth={1.5}
														aria-hidden="true"
													/>
												) : null}
											</span>
										</DropdownMenu.Item>
									);
								})}
							</DropdownMenu.Content>
						</DropdownMenu.Portal>
					</DropdownMenu.Root>
				</div>
			</div>
			{activeView === "overview" ? (
				overview
			) : activeView === "files" ? (
				<FilesInspector
					changes={fileChanges}
					selectedPath={selectedFilePath}
					onSelectPath={onSelectFilePath ?? (() => undefined)}
					projectId={projectId}
					sessionId={sessionId}
					active={!collapsed && activeView === "files"}
				/>
			) : activeView === "diff" && fileChanges.length > 0 ? (
				<DiffInspector
					changes={fileChanges}
					selectedPath={selectedFilePath}
					projectId={projectId}
					sessionId={sessionId}
				/>
			) : activeView === "pr" && pullRequest ? (
				<PullRequestInspector
					key={`${pullRequest.repositoryId}:${pullRequest.number ?? ""}`}
					repository={pullRequest}
				/>
			) : activeView === "memory" ? (
				<MemoryInspector
					active={!collapsed && activeView === "memory"}
					focus={memoryFocus}
					onOpenChat={onOpenChat ?? (() => false)}
				/>
			) : activeView === "preview" ? (
				<PreviewInspector
					key={`${projectId ?? ""}:${sessionId ?? ""}`}
					projectId={projectId}
					sessionId={sessionId}
					active={!collapsed && activeView === "preview"}
				/>
			) : activeView === "desktop" ? null : activeView === "terminal" ? (
				<TerminalInspector
					key={`${projectId ?? ""}:${sessionId ?? ""}`}
					projectId={projectId}
					sessionId={sessionId}
					active={!collapsed && activeView === "terminal"}
				/>
			) : currentView ? (
				<section
					className="inspector-empty"
					data-kind={activeView}
					aria-live="polite"
				>
					<h2>{currentView.title}</h2>
					<p>{currentView.description}</p>
				</section>
			) : null}
			{(activeView === "desktop" || openedViews.includes("desktop")) && (
				<div
					key={`desktop:${projectId ?? ""}:${sessionId ?? ""}`}
					style={{
						display: activeView === "desktop" ? "flex" : "none",
						flex: 1,
						minHeight: 0,
						minWidth: 0,
						overflow: "hidden",
					}}
				>
					<DesktopInspector
						desktop={desktop}
						busy={desktopBusy}
						projectId={projectId}
						sessionId={sessionId}
						onStart={onStartDesktop}
						active={!collapsed && activeView === "desktop"}
					/>
				</div>
			)}
		</aside>
	);
}
