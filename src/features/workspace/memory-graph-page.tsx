import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	FolderInput,
	MessageSquare,
	Minus,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Scan,
	Trash2,
	X,
} from "lucide-react";
import {
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { MEMORY_EDIT_TEXT_MAX, type MemoryEdit } from "#/domain/memory-edit";
import {
	type BlockCell,
	blockHue,
	CELL,
	CELL_GAP,
	memoryBlocks,
	nodeId,
	PERSONAL_HUE,
	recencyTint,
} from "#/domain/memory-graph";
import { memoryRows } from "#/domain/memory-overview";
import { saveErrorMessage } from "#/lib/optimistic-mutation";
import { editMemoryFn, readMemoryFn, readMemoryGraphFn } from "./memory.fn";
import { editorToReopen, memoryEditSave } from "./memory-edit-save";
import {
	formatMemoryDate,
	type MemoryViewProject,
	memoryLineRef,
	useMemoryScopeNames,
} from "./memory-inspector";
import { MemoryScopeMenu } from "./memory-menu";
import "./memory-inspector.css";

const today = () => new Date().toISOString().slice(0, 10);
/** Room around a block's grid for the selection frame and the new pixel. */
const PAD = 6;

type View = { x: number; y: number; k: number };
const IDENTITY: View = { x: 0, y: 0, k: 1 };

function formatFullDate(date: string) {
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

/**
 * One memory as a sharp square: solid when pinned, tinted by recency
 * otherwise, a centre pixel when inferred, hatched when archived, and a
 * detached corner pixel when new. Centred on 0,0.
 */
export function MemoryMark({
	cell,
	hue,
	hatch,
	size = CELL,
	selected,
}: {
	cell: Pick<BlockCell, "pinned" | "archived" | "inferred" | "fresh" | "tint">;
	hue: string;
	/** Id of the hatch pattern for archived cells. */
	hatch: string;
	size?: number;
	selected?: boolean;
}) {
	const h = size / 2;
	return (
		<>
			{selected ? (
				<rect
					className="memory-mark-frame"
					x={-h - 4}
					y={-h - 4}
					width={size + 8}
					height={size + 8}
				/>
			) : null}
			{cell.archived ? (
				<rect
					data-mark="archived"
					x={-h + 0.5}
					y={-h + 0.5}
					width={size - 1}
					height={size - 1}
					fill={`url(#${hatch})`}
					stroke={hue}
					strokeOpacity={0.35}
				/>
			) : cell.pinned ? (
				<rect
					data-mark="pinned"
					x={-h}
					y={-h}
					width={size}
					height={size}
					fill={hue}
				/>
			) : (
				<rect
					data-mark="memory"
					x={-h + 0.5}
					y={-h + 0.5}
					width={size - 1}
					height={size - 1}
					fill={hue}
					fillOpacity={cell.tint}
					stroke={hue}
					strokeOpacity={0.8}
				/>
			)}
			{cell.inferred && !cell.archived ? (
				<rect
					data-mark="inferred"
					x={-1.5}
					y={-1.5}
					width={3}
					height={3}
					fill={cell.pinned ? "#0f0f10" : hue}
				/>
			) : null}
			{cell.fresh ? (
				<rect
					data-mark="new"
					className="memory-mark-new"
					x={h + 2}
					y={-h - 5}
					width={3}
					height={3}
				/>
			) : null}
		</>
	);
}

/**
 * The memory graph as Blocks: one quiet block of squares per memory folder
 * (Personal, then each project by name), newest first, brightness by recency, no edges. Pan, wheel or
 * pinch zoom, and fit; hover for the line; select for its card and the
 * list's edits. The layout is fixed by the data, so the first render is
 * the final one.
 */
export function MemoryGraphPage({
	active,
	onOpenChat,
	projects,
}: {
	active: boolean;
	onOpenChat: (chatId: string) => boolean;
	projects?: readonly MemoryViewProject[];
}) {
	const readMemory = useServerFn(readMemoryFn);
	const readGraph = useServerFn(readMemoryGraphFn);
	const editMemory = useServerFn(editMemoryFn);
	const queryClient = useQueryClient();
	const memory = useQuery({
		queryKey: ["memory"],
		queryFn: () => readMemory(),
		enabled: active,
	});
	const graphData = useQuery({
		queryKey: ["memory-graph", memory.data?.files],
		queryFn: () => readGraph(),
		enabled: active && Boolean(memory.data?.available),
		staleTime: 60_000,
	});
	const [project, setProject] = useState<string | null>(null);
	const [newOnly, setNewOnly] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const [hovered, setHovered] = useState<{
		id: string;
		left: number;
		top: number;
	} | null>(null);
	const [view, setView] = useState<View>(IDENTITY);
	const hatch = `memory-hatch-${useId().replaceAll(":", "")}`;
	const repo = useMemo(
		() =>
			Object.fromEntries(
				(memory.data?.files ?? []).map((file) => [file.path, file.content]),
			),
		[memory.data?.files],
	);
	const date = today();
	const rows = useMemo(() => memoryRows(repo, date), [repo, date]);
	const { scopeTitle, choices } = useMemoryScopeNames(rows, projects);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scopeTitle is new each render; its names come from rows and projects.
	const blocks = useMemo(
		() => memoryBlocks({ rows, today: date, name: scopeTitle }),
		[rows, date, projects],
	);
	const cells = useMemo(
		() =>
			new Map(
				blocks.flatMap((block) =>
					block.cells.map((cell) => [cell.id, cell] as const),
				),
			),
		[blocks],
	);

	const viewport = useRef<HTMLDivElement>(null);
	const world = useRef<HTMLDivElement>(null);
	const fitView = () => {
		const frame = viewport.current;
		const content = world.current;
		if (!frame || !content) return setView(IDENTITY);
		const k = Math.max(
			0.2,
			Math.min(1, frame.clientHeight / Math.max(1, content.offsetHeight)),
		);
		setView({ k, x: (frame.clientWidth * (1 - k)) / 2, y: 0 });
	};
	const zoomAt = (factor: number, px?: number, py?: number) =>
		setView((current) => {
			const frame = viewport.current;
			const x = px ?? (frame?.clientWidth ?? 0) / 2;
			const y = py ?? (frame?.clientHeight ?? 0) / 2;
			const k = Math.max(0.2, Math.min(5, current.k * factor));
			return {
				k,
				x: x - ((x - current.x) / current.k) * k,
				y: y - ((y - current.y) / current.k) * k,
			};
		});
	const zoomRef = useRef(zoomAt);
	zoomRef.current = zoomAt;

	// Wheel and trackpad pinch zoom around the cursor (non-passive, so the
	// page does not scroll).
	const hasBlocks = blocks.length > 0;
	useEffect(() => {
		const element = viewport.current;
		if (!element || !hasBlocks) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = element.getBoundingClientRect();
			zoomRef.current(
				Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)),
				event.clientX - rect.left,
				event.clientY - rect.top,
			);
		};
		element.addEventListener("wheel", wheel, { passive: false });
		return () => element.removeEventListener("wheel", wheel);
	}, [hasBlocks]);

	useEffect(() => {
		if (!selected) return;
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") setSelected(null);
		};
		document.addEventListener("keydown", close);
		return () => document.removeEventListener("keydown", close);
	}, [selected]);

	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const gesture = useRef<{
		id: string | null;
		moved: boolean;
		last: { x: number; y: number };
		distance: number | null;
	} | null>(null);
	const cellAt = (target: EventTarget | null) =>
		(target as Element | null)
			?.closest?.("[data-cell]")
			?.getAttribute("data-cell") ?? null;
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.pointerType === "mouse" && event.button !== 0) return;
		pointers.current.set(event.pointerId, {
			x: event.clientX,
			y: event.clientY,
		});
		const current = gesture.current;
		if (pointers.current.size === 2 && current) {
			const [a, b] = [...pointers.current.values()];
			current.distance = Math.hypot(a.x - b.x, a.y - b.y);
			current.moved = true;
			return;
		}
		gesture.current = {
			id: cellAt(event.target),
			moved: false,
			last: { x: event.clientX, y: event.clientY },
			distance: null,
		};
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current;
		if (!current || !pointers.current.has(event.pointerId)) {
			if (event.pointerType !== "mouse") return;
			const id = cellAt(event.target);
			const rect = viewport.current?.getBoundingClientRect();
			if (id && rect) {
				// Beside the pointer, kept inside the frame (the tip is 240px wide).
				const left = event.clientX - rect.left + 14;
				setHovered({
					id,
					left: Math.max(8, left + 240 > rect.width ? left - 268 : left),
					top: event.clientY - rect.top + 14,
				});
			} else if (hovered) setHovered(null);
			return;
		}
		pointers.current.set(event.pointerId, {
			x: event.clientX,
			y: event.clientY,
		});
		if (pointers.current.size === 2 && current.distance) {
			const [a, b] = [...pointers.current.values()];
			const distance = Math.hypot(a.x - b.x, a.y - b.y);
			const rect = event.currentTarget.getBoundingClientRect();
			zoomAt(
				distance / current.distance,
				(a.x + b.x) / 2 - rect.left,
				(a.y + b.y) / 2 - rect.top,
			);
			current.distance = distance;
			return;
		}
		const dx = event.clientX - current.last.x;
		const dy = event.clientY - current.last.y;
		if (!current.moved && Math.hypot(dx, dy) < 4) return;
		if (!current.moved) event.currentTarget.setPointerCapture(event.pointerId);
		current.moved = true;
		current.last = { x: event.clientX, y: event.clientY };
		setHovered(null);
		setView((value) => ({ ...value, x: value.x + dx, y: value.y + dy }));
	};
	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		pointers.current.delete(event.pointerId);
		const current = gesture.current;
		if (!current) return;
		if (!current.moved && pointers.current.size === 0) {
			setHovered(null);
			setSelected((value) =>
				current.id && current.id !== value ? current.id : null,
			);
		}
		if (pointers.current.size === 0) gesture.current = null;
	};

	const editSave = memoryEditSave(queryClient, editMemory);
	/** A text edit the server refused: its editor reopens with what was typed. */
	const [retryDraft, setRetryDraft] = useState<{
		key: string;
		text: string;
	} | null>(null);
	const edit = useMutation({
		...editSave,
		onMutate: (data) => {
			setRetryDraft(null);
			if (data.op === "delete") setSelected(null);
			return editSave.onMutate(data);
		},
		onError: (error, data, snapshot) => {
			editSave.onError(error, data, snapshot);
			// The card of the line that failed shows the error, a delete too.
			if (data.op !== "add") setSelected(nodeId(data.ref));
			const reopen = editorToReopen(data);
			if (reopen) {
				setSelected(reopen.key);
				setRetryDraft(reopen);
			}
		},
	});

	if (memory.isPending) return <MemoryGraphLoading />;
	// A failed refetch keeps the last memory on screen; only a first read
	// that failed has nothing to show.
	if (!memory.data)
		return (
			<section className="memory-graph-page memory-graph-empty">
				Couldn't load memory.
				<button type="button" onClick={() => void memory.refetch()}>
					Retry
				</button>
			</section>
		);
	if (!memory.data.available)
		return (
			<section className="memory-graph-page memory-graph-empty">
				Memory is unavailable.
			</section>
		);

	const titles = graphData.data?.titles ?? {};
	const sourceLabel = (cell: BlockCell) =>
		cell.row.manual
			? "Added by you"
			: cell.row.chatId
				? titles[cell.row.chatId]?.trim() || "Chat"
				: "Earlier memory";
	const selectedCell = selected ? cells.get(selected) : undefined;
	const related = (cell: BlockCell) => {
		const focus = selectedCell;
		if (!focus) return true;
		return (
			cell.id === focus.id ||
			cell.id === focus.replaces ||
			cell.id === focus.replacedBy ||
			Boolean(focus.row.chatId && cell.row.chatId === focus.row.chatId)
		);
	};
	const hoveredCell = hovered ? cells.get(hovered.id) : undefined;
	const total = cells.size;
	return (
		<section className="memory-graph-page" aria-label="Memory graph">
			{hasBlocks ? (
				<fieldset className="memory-blocks-chips" aria-label="Filter">
					<button
						type="button"
						aria-pressed={project === null}
						onClick={() => setProject(null)}
					>
						All
					</button>
					{blocks.map((block) => (
						<button
							key={block.scope}
							type="button"
							aria-pressed={project === block.scope}
							onClick={() =>
								setProject((value) =>
									value === block.scope ? null : block.scope,
								)
							}
						>
							<i style={{ background: blockHue(block.scope) }} />
							{scopeTitle(block.scope)}
						</button>
					))}
					<button
						type="button"
						aria-pressed={newOnly}
						title="Added in the last 7 days"
						onClick={() => setNewOnly((value) => !value)}
					>
						New
					</button>
				</fieldset>
			) : null}
			<div className="memory-blocks-stage">
				{hasBlocks ? (
					<div
						ref={viewport}
						className="memory-blocks-viewport"
						role="application"
						aria-label={`Memory blocks: ${total} ${total === 1 ? "memory" : "memories"} in ${blocks.length} ${blocks.length === 1 ? "folder" : "folders"}`}
						onPointerDown={onPointerDown}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
						onPointerCancel={onPointerUp}
						onPointerLeave={() => setHovered(null)}
					>
						<svg className="memory-blocks-defs" aria-hidden="true">
							<defs>
								<pattern
									id={hatch}
									width={4}
									height={4}
									patternUnits="userSpaceOnUse"
									patternTransform="rotate(45)"
								>
									<rect width={1} height={4} fill="#ffffff40" />
								</pattern>
							</defs>
						</svg>
						<div
							ref={world}
							className="memory-blocks-world"
							style={
								view === IDENTITY
									? undefined
									: {
											transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
										}
							}
						>
							{blocks.map((block) => {
								const hue = blockHue(block.scope);
								const title = scopeTitle(block.scope);
								return (
									<section
										key={block.scope}
										className="memory-block"
										aria-label={title}
										data-dim={
											project && project !== block.scope ? "true" : undefined
										}
									>
										<header>
											<i style={{ background: hue }} />
											<strong>{title}</strong>
											<small>
												{block.active} active
												{block.fresh ? ` · ${block.fresh} new` : ""}
											</small>
										</header>
										<svg
											width={block.width + PAD * 2}
											height={block.height + PAD * 2}
											viewBox={`${-PAD} ${-PAD} ${block.width + PAD * 2} ${block.height + PAD * 2}`}
										>
											<title>{title}</title>
											{block.cells.map((cell) => (
												// biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a <button>.
												<g
													key={cell.id}
													className="memory-cell"
													data-cell={cell.id}
													role="button"
													tabIndex={0}
													aria-label={cell.row.text}
													aria-pressed={selected === cell.id}
													data-dim={
														newOnly && !cell.fresh
															? "true"
															: selectedCell && !related(cell)
																? "soft"
																: undefined
													}
													transform={`translate(${cell.x + CELL / 2} ${cell.y + CELL / 2})`}
													onKeyDown={(event) => {
														if (event.key !== "Enter" && event.key !== " ")
															return;
														event.preventDefault();
														setSelected((value) =>
															value === cell.id ? null : cell.id,
														);
													}}
												>
													<rect
														className="memory-cell-hit"
														x={-CELL / 2 - CELL_GAP / 2}
														y={-CELL / 2 - CELL_GAP / 2}
														width={CELL + CELL_GAP}
														height={CELL + CELL_GAP}
													/>
													<MemoryMark
														cell={cell}
														hue={hue}
														hatch={hatch}
														selected={selected === cell.id}
													/>
												</g>
											))}
										</svg>
									</section>
								);
							})}
						</div>
					</div>
				) : (
					<p className="memory-graph-empty">No memory yet.</p>
				)}

				{hasBlocks ? (
					<div className="memory-blocks-zoom">
						<button
							type="button"
							aria-label="Zoom in"
							title="Zoom in"
							onClick={() => zoomAt(1.25)}
						>
							<Plus size={15} />
						</button>
						<button
							type="button"
							aria-label="Zoom out"
							title="Zoom out"
							onClick={() => zoomAt(0.8)}
						>
							<Minus size={15} />
						</button>
						<button
							type="button"
							aria-label="Fit"
							title="Fit"
							onClick={fitView}
						>
							<Scan size={15} />
						</button>
					</div>
				) : null}

				{hoveredCell && hovered ? (
					<div
						className="memory-blocks-tip"
						role="tooltip"
						style={{ left: hovered.left, top: hovered.top }}
					>
						<b>{hoveredCell.row.text}</b>
						<span>
							{scopeTitle(hoveredCell.scope)}
							{hoveredCell.row.added
								? ` · ${formatMemoryDate(hoveredCell.row.added)}`
								: ""}
							{hoveredCell.fresh ? " · new" : ""}
							{hoveredCell.archived ? " · archived" : ""}
						</span>
					</div>
				) : null}

				{selectedCell ? (
					<MemoryCard
						key={selectedCell.id}
						cell={selectedCell}
						hue={blockHue(selectedCell.scope)}
						scopeLabel={scopeTitle(selectedCell.scope)}
						source={sourceLabel(selectedCell)}
						replaces={
							selectedCell.replaces
								? cells.get(selectedCell.replaces)?.row.text
								: undefined
						}
						replacedOn={
							selectedCell.replacedBy
								? (cells.get(selectedCell.replacedBy)?.row.added ?? "")
								: undefined
						}
						choices={choices}
						error={
							edit.data && !edit.data.ok
								? edit.data.error
								: saveErrorMessage(edit.error)
						}
						onClose={() => setSelected(null)}
						onOpenChat={onOpenChat}
						onEdit={(data) => edit.mutate(data)}
						retryDraft={
							retryDraft?.key === selectedCell.id ? retryDraft : undefined
						}
					/>
				) : null}
			</div>
			{hasBlocks ? <MemoryBlocksKey hatch={`${hatch}-key`} /> : null}
		</section>
	);
}

/** The graph before its data (or its code) is ready: the same box as the graph. */
export function MemoryGraphLoading() {
	return (
		<section className="memory-graph-page memory-graph-empty">
			Loading memory…
		</section>
	);
}

/** The selected memory: its text, dates, source, kind, what it replaced, and the list's edits. */
function MemoryCard({
	cell,
	hue,
	scopeLabel,
	source,
	replaces,
	replacedOn,
	choices,
	error,
	onClose,
	onOpenChat,
	onEdit,
	retryDraft,
}: {
	cell: BlockCell;
	hue: string;
	scopeLabel: string;
	source: string;
	/** Text of the line this one replaced. */
	replaces?: string;
	/** Date the line that replaced this one was added ("" when unknown). */
	replacedOn?: string;
	choices: ReturnType<typeof useMemoryScopeNames>["choices"];
	error?: string;
	onClose: () => void;
	onOpenChat: (chatId: string) => boolean;
	onEdit: (edit: MemoryEdit) => void;
	/** What the user had typed, when the server refused the edit. */
	retryDraft?: { text: string };
}) {
	const { row } = cell;
	const [editing, setEditing] = useState(Boolean(retryDraft));
	const [draft, setDraft] = useState(retryDraft?.text ?? row.text);
	useEffect(() => {
		if (!retryDraft) return;
		setDraft(retryDraft.text);
		setEditing(true);
	}, [retryDraft]);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const ref = memoryLineRef(row);
	const details: [string, string][] = [];
	if (row.added)
		details.push([
			"Added",
			`${formatFullDate(row.added)}${cell.age === null ? "" : cell.age === 0 ? " · today" : ` · ${cell.age}d ago`}`,
		]);
	details.push(["Source", source]);
	details.push(["Kind", row.kind === "inferred" ? "Inferred" : "Stated"]);
	if (replaces)
		details.push([
			"Replaces",
			`“${replaces.length > 60 ? `${replaces.slice(0, 57)}…` : replaces}”`,
		]);
	if (replacedOn !== undefined)
		details.push([
			"Replaced",
			replacedOn ? formatFullDate(replacedOn) : "By a later chat",
		]);
	else if (row.replaced)
		details.push([
			"Status",
			row.expires ? `Expired ${formatFullDate(row.expires)}` : "Replaced",
		]);
	else if (row.expires) details.push(["Expires", formatFullDate(row.expires)]);
	return (
		<aside className="memory-blocks-card" aria-label="Memory">
			<header>
				<span>
					<i style={{ background: hue }} />
					{scopeLabel}
					{cell.pinned ? " · always on" : ""}
				</span>
				<button type="button" aria-label="Close" onClick={onClose}>
					<X size={14} />
				</button>
			</header>
			{editing ? (
				<textarea
					aria-label="Memory text"
					maxLength={MEMORY_EDIT_TEXT_MAX}
					value={draft}
					// biome-ignore lint/a11y/noAutofocus: the user just asked to edit.
					autoFocus
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setEditing(false);
						}
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							if (draft.trim() && draft.trim() !== row.text)
								onEdit({ op: "update", ref, text: draft });
							setEditing(false);
						}
					}}
				/>
			) : (
				<p className="memory-blocks-text">{row.text}</p>
			)}
			<dl>
				{details.map(([term, value]) => (
					<div key={term}>
						<dt>{term}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			{confirmDelete ? (
				<div className="memory-blocks-actions">
					<span>Delete?</span>
					<button
						type="button"
						className="memory-danger"
						onClick={() => onEdit({ op: "delete", ref })}
					>
						Delete
					</button>
					<button type="button" onClick={() => setConfirmDelete(false)}>
						Cancel
					</button>
				</div>
			) : (
				<div className="memory-blocks-actions">
					{row.replaced ? null : (
						<>
							<button
								type="button"
								title="Edit text"
								onClick={() => {
									setDraft(row.text);
									setEditing(true);
								}}
							>
								<Pencil size={13} aria-hidden="true" /> Edit
							</button>
							<button
								type="button"
								aria-pressed={row.rule}
								title={
									row.rule
										? "Stop attaching to every chat"
										: "Attach to every chat"
								}
								onClick={() => onEdit({ op: "update", ref, always: !row.rule })}
							>
								{row.rule ? (
									<PinOff size={13} aria-hidden="true" />
								) : (
									<Pin size={13} aria-hidden="true" />
								)}
								{row.rule ? "Unpin" : "Pin"}
							</button>
							<MemoryScopeMenu
								label="Move to"
								choices={choices}
								value={row.project ?? null}
								onChoose={(project) => {
									if ((project ?? "") !== (row.project ?? ""))
										onEdit({ op: "update", ref, project });
								}}
							>
								<button type="button" title="Move to another folder">
									<FolderInput size={13} aria-hidden="true" /> Move
								</button>
							</MemoryScopeMenu>
						</>
					)}
					{row.chatId ? (
						<a
							href={`/?chat=${row.chatId}`}
							title={`Open ${source}`}
							onClick={(event) => {
								if (row.chatId && onOpenChat(row.chatId))
									event.preventDefault();
							}}
						>
							<MessageSquare size={13} aria-hidden="true" /> Chat
						</a>
					) : null}
					<button
						type="button"
						aria-label="Delete"
						title="Delete"
						onClick={() => setConfirmDelete(true)}
					>
						<Trash2 size={13} aria-hidden="true" />
					</button>
				</div>
			)}
			{error ? (
				<p className="memory-composer-error" role="alert">
					{error}
				</p>
			) : null}
		</aside>
	);
}

/** The key, drawn with the graph's own mark; details in tooltips. */
export function MemoryBlocksKey({ hatch }: { hatch: string }) {
	const base = {
		pinned: false,
		archived: false,
		inferred: false,
		fresh: false,
		tint: 0.2,
	};
	const marks: [string, string, typeof base][] = [
		["Pinned", "Always on: attached to every chat", { ...base, pinned: true }],
		["Memory", "Used when relevant", base],
		[
			"Inferred",
			"The agent concluded it; you never said it",
			{ ...base, inferred: true },
		],
		[
			"Archived",
			"Replaced or expired; kept, not used",
			{ ...base, archived: true },
		],
		["New", "Added in the last 7 days", { ...base, fresh: true }],
	];
	return (
		<div className="memory-blocks-key">
			<svg className="memory-blocks-defs" aria-hidden="true">
				<defs>
					<pattern
						id={hatch}
						width={3}
						height={3}
						patternUnits="userSpaceOnUse"
						patternTransform="rotate(45)"
					>
						<rect width={1} height={3} fill="#ffffff50" />
					</pattern>
				</defs>
			</svg>
			{marks.map(([label, hint, cell]) => (
				<span key={label} title={hint}>
					<svg viewBox="-8 -8 16 16" width={14} height={14} aria-hidden="true">
						<MemoryMark cell={cell} hue={PERSONAL_HUE} hatch={hatch} size={9} />
					</svg>
					{label}
				</span>
			))}
			<span className="memory-blocks-scale" title="Brighter is newer">
				Older
				<svg viewBox="0 0 76 8" width={76} height={8} aria-hidden="true">
					{Array.from({ length: 6 }, (_, index) => (
						<rect
							// biome-ignore lint/suspicious/noArrayIndexKey: a fixed scale.
							key={index}
							x={index * 13}
							width={8}
							height={8}
							fill={PERSONAL_HUE}
							fillOpacity={recencyTint(200 - index * 40)}
						/>
					))}
				</svg>
				Newer
			</span>
		</div>
	);
}
