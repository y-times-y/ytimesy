import { PanelRight, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { FileChangeEntry } from "#/domain/session-item";
import type { WorkspaceDesktop } from "#/domain/workspace-desktop";
import { DesktopInspector } from "./desktop-inspector";
import { DiffInspector } from "./diff-inspector";

export type ToolsView = "diff" | "terminal" | "desktop";
export type InspectorView = ToolsView | "side";

const views = {
	diff: {
		label: "Diff",
		title: "No changes yet.",
		description: "File changes will appear here.",
	},
	terminal: {
		label: "Terminal",
		title: "No terminal connected.",
		description: "Start a workspace to use the terminal.",
	},
	desktop: {
		label: "Desktop",
		title: "Shared desktop",
		description:
			"This is the Linux desktop the agent uses for QA. You watch and control the same screen.",
	},
} as const;

export function WorkspaceInspector({
	collapsed,
	activeView,
	onActiveViewChange,
	fileChanges = [],
	desktop,
	desktopBusy,
	onStartDesktop,
	sideChatOpen,
	onNewSideChat,
	onCloseSideChat,
	onCollapse,
	sideChat,
}: {
	collapsed: boolean;
	activeView: InspectorView;
	onActiveViewChange: (view: InspectorView) => void;
	fileChanges?: readonly FileChangeEntry[];
	desktop: WorkspaceDesktop;
	desktopBusy: boolean;
	onStartDesktop: () => void;
	sideChatOpen: boolean;
	onNewSideChat: () => void;
	onCloseSideChat: () => void;
	onCollapse?: () => void;
	sideChat: ReactNode;
}) {
	const currentView = activeView === "side" ? null : views[activeView];
	return (
		<aside
			id="workspace-inspector"
			className="workspace-inspector"
			aria-label="Workspace inspector"
			inert={collapsed}
			aria-hidden={collapsed}
		>
			<div className="inspector-tabs">
				{(Object.keys(views) as ToolsView[]).map((view) => (
					<button
						type="button"
						key={view}
						aria-pressed={activeView === view}
						onClick={() => onActiveViewChange(view)}
					>
						{views[view].label}
					</button>
				))}
				{sideChatOpen ? (
					<div
						className="inspector-side-tab"
						data-active={activeView === "side"}
					>
						<button
							type="button"
							aria-pressed={activeView === "side"}
							onClick={() => onActiveViewChange("side")}
						>
							New Side Chat
						</button>
						<button
							type="button"
							className="inspector-side-close"
							aria-label="Close side chat"
							onClick={onCloseSideChat}
						>
							<X size={14} />
						</button>
					</div>
				) : null}
				<button
					type="button"
					className="inspector-new-tab"
					aria-label="New side chat"
					title="New side chat"
					onClick={onNewSideChat}
				>
					<Plus size={16} />
				</button>
				{onCollapse ? (
					<button
						type="button"
						className="inspector-collapse"
						aria-label="Hide tools"
						title="Hide tools"
						onClick={onCollapse}
					>
						<PanelRight size={16} />
					</button>
				) : null}
			</div>
			{activeView === "side" ? (
				sideChat
			) : activeView === "diff" && fileChanges.length > 0 ? (
				<DiffInspector changes={fileChanges} />
			) : activeView === "desktop" ? (
				<DesktopInspector
					desktop={desktop}
					busy={desktopBusy}
					onStart={onStartDesktop}
				/>
			) : currentView ? (
				<section className="inspector-empty" aria-live="polite">
					<h2>{currentView.title}</h2>
					<p>{currentView.description}</p>
				</section>
			) : null}
		</aside>
	);
}
