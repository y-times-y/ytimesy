import type { FileChangeEntry } from "#/domain/session-item";
import { FileChangeList } from "../sessions/file-change-row";

export type InspectorView = "diff" | "terminal" | "preview";

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
}: {
	collapsed: boolean;
	activeView: InspectorView;
	onActiveViewChange: (view: InspectorView) => void;
	fileChanges?: readonly FileChangeEntry[];
}) {
	const currentView = views[activeView];
	return (
		<aside
			id="workspace-inspector"
			className="workspace-inspector"
			aria-label="Workspace inspector"
			inert={collapsed}
			aria-hidden={collapsed}
		>
			<div className="inspector-tabs">
				{(Object.keys(views) as InspectorView[]).map((view) => {
					return (
						<button
							type="button"
							key={view}
							aria-pressed={activeView === view}
							onClick={() => onActiveViewChange(view)}
						>
							{views[view].label}
						</button>
					);
				})}
			</div>
			{activeView === "diff" && fileChanges.length > 0 ? (
				<FileChangeList changes={fileChanges} />
			) : (
				<section className="inspector-empty" aria-live="polite">
					<h2>{currentView.title}</h2>
					<p>{currentView.description}</p>
				</section>
			)}
		</aside>
	);
}
