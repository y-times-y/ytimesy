import type { QueryClient } from "@tanstack/react-query";
import { readMemoryFn } from "./memory.fn";
import { MemoryInspector, type MemoryViewProject } from "./memory-inspector";
import "./memory-inspector.css";

export type MemoryView = "tree" | "list";

/** Reads what the Memory page shows before it opens; its queries then answer from the cache. */
export function prefetchMemoryPage(queryClient: QueryClient) {
	void queryClient
		.prefetchQuery({ queryKey: ["memory"], queryFn: () => readMemoryFn() })
		.catch(() => undefined);
}

const VIEWS: readonly { value: MemoryView; label: string; hint: string }[] = [
	{
		value: "tree",
		label: "Folders",
		hint: "Personal, then each project, as the memory repo holds them",
	},
	{ value: "list", label: "List", hint: "Every line, by topic or newest" },
];

/**
 * The one full-page Memory view from the left sidebar: the repo's folder
 * tree by default (Personal, each project, their topic files), the
 * searchable list one switch away. Both render on the server as they will
 * on the client: the tree's folders are open <details>, no layout step.
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
	projects?: readonly MemoryViewProject[];
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
							title={option.hint}
							aria-pressed={view === option.value}
							onClick={() => onViewChange(option.value)}
						>
							{option.label}
						</button>
					))}
				</fieldset>
			</header>
			<MemoryInspector
				active
				layout="page"
				arrangement={view === "tree" ? "tree" : "list"}
				projects={projects}
				onOpenChat={onOpenChat}
			/>
		</section>
	);
}
