import { Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import type { FileChangeEntry } from "#/domain/session-item";
import { FileChangeList } from "../sessions/file-change-row";

export type ToolsView = "diff" | "terminal" | "preview";
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
	preview: {
		label: "Preview",
		title: "No preview running.",
		description: "Run your app to see its preview.",
	},
} as const;

export function WorkspaceInspector({
	collapsed,
	activeView,
	onActiveViewChange,
	fileChanges = [],
	sideChatOpen,
	onNewSideChat,
	onCloseSideChat,
	sideChat,
}: {
	collapsed: boolean;
	activeView: InspectorView;
	onActiveViewChange: (view: InspectorView) => void;
	fileChanges?: readonly FileChangeEntry[];
	sideChatOpen: boolean;
	onNewSideChat: () => void;
	onCloseSideChat: () => void;
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
			</div>
			{activeView === "side" ? (
				sideChat
			) : activeView === "diff" && fileChanges.length > 0 ? (
				<FileChangeList changes={fileChanges} />
			) : currentView ? (
				<section className="inspector-empty" aria-live="polite">
					<h2>{currentView.title}</h2>
					<p>{currentView.description}</p>
				</section>
			) : null}
		</aside>
	);
}
