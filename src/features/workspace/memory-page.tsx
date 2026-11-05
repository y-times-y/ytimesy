import type { QueryClient } from "@tanstack/react-query";
import { readMemoryFn, readMemoryGraphFn } from "./memory.fn";
import { MemoryGraphPage } from "./memory-graph-page";
import { MemoryInspector, type MemoryViewProject } from "./memory-inspector";
import "./memory-inspector.css";

export type MemoryView = "blocks" | "files";

/** This browser's last Memory page view. */
export const MEMORY_VIEW_KEY = "yt.memory.view";
export const DEFAULT_MEMORY_VIEW: MemoryView = "blocks";

export function parseMemoryView(raw: string | null): MemoryView {
	return raw === "files" ? "files" : DEFAULT_MEMORY_VIEW;
}

/**
 * The view to open the Memory page in. The page never renders on the
 * server (it opens from the sidebar), so reading it as the page opens, in
 * the same update, makes its first paint the final one.
 */
export function readSavedMemoryView(): MemoryView {
	try {
		return parseMemoryView(window.localStorage.getItem(MEMORY_VIEW_KEY));
	} catch {
		return DEFAULT_MEMORY_VIEW;
	}
}

export function saveMemoryView(view: MemoryView) {
	try {
		window.localStorage.setItem(MEMORY_VIEW_KEY, view);
	} catch {
		// No storage: the page opens in Blocks next time.
	}
}

/**
 * Reads what the Memory page shows first (the files, then the chat titles
 * the Blocks card names) before it opens; its queries then answer from the
 * cache.
 */
export function prefetchMemoryPage(queryClient: QueryClient) {
	void queryClient
		.fetchQuery({ queryKey: ["memory"], queryFn: () => readMemoryFn() })
		.then((memory) =>
			memory.available
				? queryClient.prefetchQuery({
						queryKey: ["memory-graph", memory.files],
						queryFn: () => readMemoryGraphFn(),
						staleTime: 60_000,
					})
				: undefined,
		)
		.catch(() => undefined);
}

const VIEWS: readonly { value: MemoryView; label: string; hint: string }[] = [
	{
		value: "blocks",
		label: "Blocks",
		hint: "One block per folder, newest first",
	},
	{
		value: "files",
		label: "Files",
		hint: "The memory repo's folders and files, with history",
	},
];

/**
 * The one full-page Memory view from the left sidebar: Blocks by default
 * (one block of squares per folder: Personal, then each project), the
 * repo's folder tree with per-file history one switch away. Both lay out
 * from the data alone, so the first render is the final one.
 */
export function MemoryPage({
	view,
	onViewChange,
	onOpenChat,
	projects,
	focus,
}: {
	view: MemoryView;
	onViewChange: (view: MemoryView) => void;
	onOpenChat: (chatId: string) => boolean;
	projects?: readonly MemoryViewProject[];
	/** A memory file to show first, when a chat's memory marker opened this page. */
	focus?: { path: string };
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
							onClick={() => {
								saveMemoryView(option.value);
								onViewChange(option.value);
							}}
						>
							{option.label}
						</button>
					))}
				</fieldset>
			</header>
			{view === "blocks" ? (
				<MemoryGraphPage active projects={projects} onOpenChat={onOpenChat} />
			) : (
				<MemoryInspector
					active
					layout="page"
					arrangement="tree"
					focus={focus}
					projects={projects}
					onOpenChat={onOpenChat}
				/>
			)}
		</section>
	);
}
