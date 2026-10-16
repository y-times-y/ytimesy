import { ChevronRight } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import type {
	MemoryRecall,
	RecalledMemoryLine,
	SavedMemoryLine,
} from "#/domain/memory-marker";
import { MEMORY_ENTRY } from "#/domain/memory-repo";
import type { MemorySaveItem } from "#/domain/session-item";

export type MemoryMarkerActions = {
	/** Opens the Memory tab at this file. */
	readonly onOpenMemory?: (path: string) => void;
	/** Opens a chat in place; false lets the link navigate instead. */
	readonly onOpenChat?: (chatId: string) => boolean;
	/** Whether memory still holds a saved line; undefined while unknown. */
	readonly holds?: (line: SavedMemoryLine) => boolean | undefined;
	/** Removes a saved line from memory with a commit. */
	readonly onUndo?: (line: SavedMemoryLine) => Promise<{ removed: boolean }>;
};

const MemoryMarkerContext = createContext<MemoryMarkerActions>({});

export function MemoryMarkerProvider({
	actions,
	children,
}: {
	actions?: MemoryMarkerActions;
	children: ReactNode;
}) {
	if (!actions) return children;
	return (
		<MemoryMarkerContext.Provider value={actions}>
			{children}
		</MemoryMarkerContext.Provider>
	);
}

const count = (n: number) => `${n} ${n === 1 ? "memory" : "memories"}`;

function formatDate(date: string) {
	const parsed = new Date(`${date}T00:00:00Z`);
	return Number.isNaN(parsed.getTime())
		? date
		: parsed.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			});
}

function FileLink({ path }: { path: string }) {
	const { onOpenMemory } = useContext(MemoryMarkerContext);
	if (!onOpenMemory) return <span>{path}</span>;
	return (
		<button
			type="button"
			className="memory-marker-link"
			onClick={() => onOpenMemory(path)}
		>
			{path}
		</button>
	);
}

function SourceChat({
	source,
}: {
	source: NonNullable<RecalledMemoryLine["source"]>;
}) {
	const { onOpenChat } = useContext(MemoryMarkerContext);
	return (
		<>
			{" · from chat "}
			<a
				className="memory-marker-link"
				href={`/?chat=${source.chatId}`}
				onClick={(event) => {
					if (onOpenChat?.(source.chatId)) event.preventDefault();
				}}
			>
				{source.title || "an earlier chat"}
			</a>
			{source.date ? ` · ${formatDate(source.date)}` : null}
		</>
	);
}

/** Under a request: what memory was read for it, collapsed by default. */
export function MemoryRecallNote({ recall }: { recall: MemoryRecall }) {
	if (!recall.index && !recall.lines.length) return null;
	return (
		<details className="memory-marker" data-kind="recall">
			<summary className="memory-marker-summary">
				<span className="memory-marker-title">
					{recall.lines.length
						? `Recalled ${count(recall.lines.length)}`
						: "Loaded memory index"}
				</span>
				<ChevronRight
					size={12}
					className="session-activity-chevron"
					aria-hidden="true"
				/>
			</summary>
			<ul className="memory-marker-lines">
				{recall.index ? (
					<li className="memory-marker-entry">
						<span className="memory-marker-text">Loaded memory index</span>
						<span className="memory-marker-meta">
							<FileLink path={MEMORY_ENTRY} />
							{" · attached at the start of this chat"}
						</span>
					</li>
				) : null}
				{recall.lines.map((line) => (
					<li className="memory-marker-entry" key={`${line.path}:${line.text}`}>
						<span className="memory-marker-text">{line.text}</span>
						<span className="memory-marker-meta">
							<FileLink path={line.path} />
							{line.source ? <SourceChat source={line.source} /> : null}
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}

function SavedLineActions({ line }: { line: SavedMemoryLine }) {
	const { onUndo, onOpenMemory, holds } = useContext(MemoryMarkerContext);
	const [state, setState] = useState<"idle" | "undoing" | "removed" | "failed">(
		"idle",
	);
	const held = holds?.(line);
	if (state === "removed") return <span>Removed from memory</span>;
	if (held === false) return <span>No longer in memory</span>;
	return (
		<>
			{onUndo ? (
				<button
					type="button"
					className="memory-marker-link"
					disabled={state === "undoing"}
					onClick={async () => {
						setState("undoing");
						try {
							await onUndo(line);
							setState("removed");
						} catch {
							setState("failed");
						}
					}}
				>
					{state === "undoing" ? "Undoing…" : "Undo"}
				</button>
			) : null}
			{onUndo && onOpenMemory ? " · " : null}
			{onOpenMemory ? (
				<button
					type="button"
					className="memory-marker-link"
					onClick={() => onOpenMemory(line.path)}
				>
					Open in Memory
				</button>
			) : null}
			{state === "failed" ? (
				<span role="alert"> · Could not undo; try again.</span>
			) : null}
		</>
	);
}

/** After a turn's answer: the memory it saved, each line with Undo. */
export function MemorySaveNote({ item }: { item: MemorySaveItem }) {
	const [only] = item.lines;
	if (!only) return null;
	if (item.lines.length === 1)
		return (
			<div className="memory-marker" data-kind="save">
				<p className="memory-marker-single">
					<span className="memory-marker-title">
						Saved to memory: “{only.text}”
					</span>
					<span className="memory-marker-meta">
						<SavedLineActions line={only} />
					</span>
				</p>
			</div>
		);
	return (
		<details className="memory-marker" data-kind="save">
			<summary className="memory-marker-summary">
				<span className="memory-marker-title">
					Saved {count(item.lines.length)}
				</span>
				<ChevronRight
					size={12}
					className="session-activity-chevron"
					aria-hidden="true"
				/>
			</summary>
			<ul className="memory-marker-lines">
				{item.lines.map((line) => (
					<li className="memory-marker-entry" key={`${line.path}:${line.text}`}>
						<span className="memory-marker-text">“{line.text}”</span>
						<span className="memory-marker-meta">
							<FileLink path={line.path} />
							{" · "}
							<SavedLineActions line={line} />
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}
