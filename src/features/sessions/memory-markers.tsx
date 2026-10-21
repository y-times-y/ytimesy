import { BookMarked, BookmarkPlus, ChevronRight } from "lucide-react";
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

/** Longer lines show their start; More shows the rest. */
export const CLIPPED_MEMORY_LINE = 140;

function MemoryLineText({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	const long = text.length > CLIPPED_MEMORY_LINE;
	return (
		<span className="memory-marker-text">
			{long && !open
				? `${text.slice(0, CLIPPED_MEMORY_LINE - 1).trimEnd()}…`
				: text}
			{long ? (
				<button
					type="button"
					className="memory-marker-link memory-marker-more"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					{open ? "Less" : "More"}
				</button>
			) : null}
		</span>
	);
}

function MemorySummary({
	icon: Icon,
	label,
	note,
}: {
	icon: typeof BookMarked;
	label: string;
	note?: string;
}) {
	return (
		<summary className="memory-marker-summary">
			<Icon
				className="memory-marker-icon"
				size={14}
				strokeWidth={1.5}
				aria-hidden="true"
			/>
			<span className="memory-marker-title">{label}</span>
			{note ? <span className="memory-marker-note">{note}</span> : null}
			<ChevronRight
				size={12}
				className="session-activity-chevron"
				aria-hidden="true"
			/>
		</summary>
	);
}

function RecalledRow({ line }: { line: RecalledMemoryLine }) {
	return (
		<li className="memory-marker-entry">
			<MemoryLineText text={line.text} />
			<span className="memory-marker-meta">
				<FileLink path={line.path} />
				{line.source ? <SourceChat source={line.source} /> : null}
			</span>
		</li>
	);
}

/**
 * Under a request: the memory used for it, collapsed to a count. Open, it
 * lists the standing project rules and the lines matched for this request
 * as separate groups, one line per row with its file and source muted.
 */
export function MemoryRecallNote({ recall }: { recall: MemoryRecall }) {
	if (!recall.index && !recall.lines.length) return null;
	const rules = recall.lines.filter((line) => line.rule);
	const matched = recall.lines.filter((line) => !line.rule);
	return (
		<details className="memory-marker" data-kind="recall">
			<MemorySummary
				icon={BookMarked}
				label={
					recall.lines.length
						? `Used ${count(recall.lines.length)}`
						: "Used the memory index"
				}
				note={
					rules.length
						? `${rules.length} project ${rules.length === 1 ? "rule" : "rules"}`
						: undefined
				}
			/>
			<div className="memory-marker-body">
				{rules.length ? (
					<section className="memory-marker-group" aria-label="Project rules">
						<div className="memory-marker-group-title">Project rules</div>
						<ul className="memory-marker-lines">
							{rules.map((line) => (
								<RecalledRow key={`${line.path}:${line.text}`} line={line} />
							))}
						</ul>
					</section>
				) : null}
				{matched.length ? (
					<section
						className="memory-marker-group"
						aria-label={rules.length ? "Matched this request" : undefined}
					>
						{rules.length ? (
							<div className="memory-marker-group-title">
								Matched this request
							</div>
						) : null}
						<ul className="memory-marker-lines">
							{matched.map((line) => (
								<RecalledRow key={`${line.path}:${line.text}`} line={line} />
							))}
						</ul>
					</section>
				) : null}
				{recall.index ? (
					<div className="memory-marker-meta memory-marker-index">
						{"Memory index "}
						<FileLink path={MEMORY_ENTRY} />
						{" attached at the start of this chat"}
					</div>
				) : null}
			</div>
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
				<span role="alert">Could not undo; try again.</span>
			) : null}
		</>
	);
}

/** After a turn's answer: the memory it saved, collapsed to a count; open, each line with Undo. */
export function MemorySaveNote({ item }: { item: MemorySaveItem }) {
	if (!item.lines.length) return null;
	return (
		<details className="memory-marker" data-kind="save">
			<MemorySummary
				icon={BookmarkPlus}
				label={`Saved ${count(item.lines.length)}`}
			/>
			<div className="memory-marker-body">
				<ul className="memory-marker-lines">
					{item.lines.map((line) => (
						<li
							className="memory-marker-entry"
							key={`${line.path}:${line.text}`}
						>
							<MemoryLineText text={line.text} />
							<span className="memory-marker-meta">
								<FileLink path={line.path} />
								<span className="memory-marker-actions">
									<SavedLineActions line={line} />
								</span>
							</span>
						</li>
					))}
				</ul>
			</div>
		</details>
	);
}
