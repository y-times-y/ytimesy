import { useState } from "react";
import type { FileChangeEntry } from "#/domain/session-item";

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

type InspectorView = keyof typeof views;

export function WorkspaceInspector({
	collapsed,
	fileChanges = [],
}: {
	collapsed: boolean;
	fileChanges?: readonly FileChangeEntry[];
}) {
	const [activeView, setActiveView] = useState<InspectorView>("diff");
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
							onClick={() => setActiveView(view)}
						>
							{views[view].label}
						</button>
					);
				})}
			</div>
			{activeView === "diff" && fileChanges.length > 0 ? (
				<ul className="inspector-changes" aria-label="File changes">
					{fileChanges.map((change) => (
						<li key={`${change.change}:${change.path}`}>
							<span>{change.change}</span>
							{change.path}
						</li>
					))}
				</ul>
			) : (
				<section className="inspector-empty" aria-live="polite">
					<h2>{currentView.title}</h2>
					<p>{currentView.description}</p>
				</section>
			)}
		</aside>
	);
}
