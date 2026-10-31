import { Check, ListTodo, Plus, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { type ReactNode, useEffect, useState } from "react";
import type { AgentProviderId } from "#/domain/agent-provider";
import type { FileChangeEntry } from "#/domain/session-item";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { DesktopInspector } from "./desktop-inspector";
import { DiffInspector } from "./diff-inspector";
import { FilesInspector } from "./files-inspector";
import { MemoryInspector } from "./memory-inspector";
import {
	PullRequestInspector,
	type PullRequestRepository,
} from "./pull-request-inspector";
import { TerminalInspector } from "./terminal-inspector";
import { VIEW_ICONS } from "./view-icons";

export type ToolsView =
	| "files"
	| "diff"
	| "pr"
	| "terminal"
	| "desktop"
	| "memory"
	| "side";
export type InspectorView = ToolsView | "overview";

const views = {
	files: {
		label: "Files",
		icon: VIEW_ICONS.files,
		title: "No files yet.",
		description: "The workspace tree will appear here.",
	},
	diff: {
		label: "Diff",
		icon: VIEW_ICONS.diff,
		title: "No changes yet.",
		description: "Changes from this turn will appear here.",
	},
	pr: {
		label: "Pull request",
		icon: VIEW_ICONS.pr,
		title: "No repository connected.",
		description:
			"Connect this project to a GitHub repository to review its pull requests here.",
	},
	terminal: {
		label: "Terminal",
		icon: VIEW_ICONS.terminal,
		title: "No terminal connected.",
		description: "Start a workspace to use the terminal.",
	},
	desktop: {
		label: "Desktop",
		icon: VIEW_ICONS.desktop,
		title: "Shared desktop",
		description:
			"This is the desktop the agent uses for QA. You watch and control the same screen.",
	},
	memory: {
		label: "Memory",
		icon: VIEW_ICONS.memory,
		title: "Memory",
		description: "What the agent remembers about you across chats.",
	},
	side: {
		label: "Side chat",
		icon: VIEW_ICONS.side,
		title: "Side chat",
		description: "Open a chat first; the side chat talks beside it.",
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
	harnessId,
	modelId,
	onReviewStarted,
	overview,
	pullRequest,
	onOpenChat,
	memoryFocus,
	onViewIntent,
	sideChat,
}: {
	/** The side chat beside Main, shown in the Side chat tab. */
	sideChat?: ReactNode;
	/** The pointer or focus reached a view's entry: it may open next. */
	onViewIntent?: (view: ToolsView) => void;
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
	harnessId?: AgentProviderId;
	modelId?: string;
	/** Opens the new chat a pull-request review started. */
	onReviewStarted?: (sessionId: string) => void;
	overview: ReactNode;
	pullRequest?: PullRequestRepository;
	/** Opens a chat linked from memory; false when it is not in this project's list. */
	onOpenChat?: (chatId: string) => boolean;
}) {
	// The tab it opens on (a saved panel) is open from the server's render.
	const [openedViews, setOpenedViews] = useState<ToolsView[]>(() =>
		activeView === "overview" ? [] : [activeView],
	);
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
								onPointerEnter={() => onViewIntent?.(view)}
								onClick={() => onActiveViewChange(view)}
							>
								<TabIcon view={view} />
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
					<DropdownMenu.Root
						onOpenChange={(open) => {
							// Most of the menu's views need the chat's machine: wake it now.
							if (open) onViewIntent?.("terminal");
						}}
					>
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
											onFocus={() => onViewIntent?.(view)}
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
					projectId={projectId}
					harnessId={harnessId}
					modelId={modelId}
					currentSessionId={sessionId}
					onReviewStarted={onReviewStarted}
				/>
			) : activeView === "side" && sideChat ? (
				sideChat
			) : activeView === "memory" ? (
				<MemoryInspector
					active={!collapsed && activeView === "memory"}
					focus={memoryFocus}
					onOpenChat={onOpenChat ?? (() => false)}
				/>
			) : activeView === "desktop" && !collapsed ? (
				<DesktopInspector
					key={`${projectId ?? ""}:${sessionId ?? ""}`}
					desktop={desktop}
					busy={desktopBusy}
					projectId={projectId}
					sessionId={sessionId}
					onStart={onStartDesktop}
					active
				/>
			) : activeView === "terminal" ? (
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
		</aside>
	);
}

function TabIcon({ view }: { view: ToolsView }) {
	const Icon = views[view].icon;
	return <Icon size={16} aria-hidden="true" />;
}
