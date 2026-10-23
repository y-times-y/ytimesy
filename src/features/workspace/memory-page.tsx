import type { Project } from "#/domain/projects";
import { MemoryGraphPage } from "./memory-graph-page";
import { MemoryInspector } from "./memory-inspector";
import "./memory-inspector.css";

export type MemoryView = "graph" | "list";

const VIEWS: readonly { value: MemoryView; label: string }[] = [
	{ value: "graph", label: "Graph" },
	{ value: "list", label: "List" },
];

/**
 * The one full-page Memory view from the left sidebar: the graph by default,
 * the searchable list one switch away.
 */
export function MemoryPage({
	view,
	onViewChange,
	onOpenChat,
	projects,
}: {
	view: MemoryView;
	onViewChange: (view: MemoryView) => void;
	onOpenChat: (chatId: string) => boolean;
	projects?: readonly Project[];
}) {
	return (
		<section className="memory-page" data-view={view} aria-label="Memory">
			<header className="memory-page-header">
				<div className="memory-page-title">
					<h1>Memory</h1>
					<p>What the agent remembers across chats.</p>
				</div>
				<fieldset className="memory-page-views" aria-label="View">
					{VIEWS.map((option) => (
						<button
							key={option.value}
							type="button"
							aria-pressed={view === option.value}
							onClick={() => onViewChange(option.value)}
						>
							{option.label}
						</button>
					))}
				</fieldset>
			</header>
			{view === "graph" ? (
				<MemoryGraphPage active projects={projects} onOpenChat={onOpenChat} />
			) : (
				<MemoryInspector
					active
					layout="page"
					projects={projects}
					onOpenChat={onOpenChat}
				/>
			)}
		</section>
	);
}
