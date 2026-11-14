import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Columns2,
	ExternalLink,
	type LucideIcon,
	MessageSquarePlus,
	Monitor,
	Scan,
	Smartphone,
	Tablet,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useEffect, useState } from "react";
import { type CanvasThread, canvasStandalonePage } from "#/domain/canvas";
import {
	CANVAS_NOTES_LIMIT,
	type CanvasElementPick,
	canvasFeedbackMessage,
} from "#/domain/canvas-annotation";
import type { CanvasItem } from "#/domain/session-item";
import { CanvasNotesPanel, NoteComposer } from "./canvas-notes";
import { useCanvasNotes } from "./canvas-notes-store";
import type { CanvasFocus } from "./canvas-open-context";
import { CanvasStage, type StageMark } from "./canvas-stage";
import "./canvas.css";

/** The preview widths: the panel's own, or a device's, scaled down to fit. */
const WIDTHS = [
	{ id: "fit", label: "Fit to panel", icon: Scan, width: null },
	{ id: "desktop", label: "Desktop (1280 px)", icon: Monitor, width: 1280 },
	{ id: "tablet", label: "Tablet (768 px)", icon: Tablet, width: 768 },
	{ id: "mobile", label: "Mobile (390 px)", icon: Smartphone, width: 390 },
] as const satisfies readonly {
	id: string;
	label: string;
	icon: LucideIcon;
	width: number | null;
}[];
type PreviewWidth = (typeof WIDTHS)[number]["id"];

/** Puts text in the chat's message box: notes after the draft, a prompt instead of it. */
type Compose = (text: string, mode: "append" | "replace") => void;

/** The revision a focus names in its canvas, or the canvas's latest. */
function shownRevision(thread: CanvasThread, revision?: number): CanvasItem {
	return (
		(revision !== undefined &&
			thread.revisions.find((entry) => entry.revision === revision)) ||
		(thread.revisions.at(-1) as CanvasItem)
	);
}

/**
 * What the other side of Compare starts on: the revision before the one
 * shown, else another canvas's latest, else the same one.
 */
function comparedWith(
	canvases: readonly CanvasThread[],
	thread: CanvasThread,
	shown: CanvasItem,
): CanvasFocus {
	const position = thread.revisions.indexOf(shown);
	const before = thread.revisions[position - 1];
	if (before) return { title: thread.title, revision: before.revision };
	const other = [...canvases].reverse().find((entry) => entry !== thread);
	return { title: (other ?? thread).title };
}

/**
 * The right panel's Canvas view, where the user reviews a design with the
 * agent: the chosen canvas (the latest by default) at the chosen revision,
 * with a canvas picker, revisions, preview widths and Open in new tab;
 * Annotate pins notes on elements and sends them to the chat as one
 * message; Compare shows two revisions or canvases side by side.
 */
export function CanvasInspector({
	canvases,
	focus,
	onFocusChange,
	onCompose,
}: {
	canvases: readonly CanvasThread[];
	focus?: CanvasFocus;
	onFocusChange: (focus: CanvasFocus) => void;
	/** The chat's message box; absent where there is none to write in. */
	onCompose?: Compose;
}) {
	const [width, setWidth] = useState<PreviewWidth>("fit");
	const [annotating, setAnnotating] = useState(false);
	const [compare, setCompare] = useState<CanvasFocus | null>(null);
	const thread =
		canvases.find((entry) => entry.title === focus?.title) ?? canvases.at(-1);
	if (!thread)
		return (
			<section className="inspector-empty" data-kind="canvas">
				<h2>No canvas yet.</h2>
				<p>
					When an agent shares a design (mockups, options side by side, a flow),
					it opens here to review, annotate and compare.
				</p>
			</section>
		);
	const shown = shownRevision(
		thread,
		focus?.title === thread.title ? focus.revision : undefined,
	);
	const latest = thread.revisions.at(-1) as CanvasItem;
	const pick = (title: string, revision?: number) => {
		const target = canvases.find((entry) => entry.title === title);
		const latestOf = target?.revisions.at(-1)?.revision;
		onFocusChange({
			title,
			...(revision === undefined || revision === latestOf ? {} : { revision }),
		});
	};
	const preview = WIDTHS.find((entry) => entry.id === width) ?? WIDTHS[0];
	const prompt = onCompose
		? (text: string) => onCompose(text, "replace")
		: undefined;
	const comparing = compare !== null;
	const compareThread = compare
		? (canvases.find((entry) => entry.title === compare.title) ?? thread)
		: null;
	return (
		<section className="canvas-inspector" aria-label="Canvas">
			<header className="canvas-inspector-bar">
				{comparing ? (
					<span className="canvas-picker" data-single="true">
						Compare
					</span>
				) : (
					<>
						<CanvasPicker
							canvases={canvases}
							current={thread.title}
							onPick={(title) => pick(title)}
						/>
						<RevisionStepper
							thread={thread}
							shown={shown}
							onStep={(revision) => pick(thread.title, revision)}
						/>
					</>
				)}
				<div className="canvas-inspector-spacer" />
				<div className="canvas-modes">
					<button
						type="button"
						className="canvas-mode-button"
						aria-pressed={annotating}
						disabled={comparing || shown.html === null}
						title="Annotate: click elements to pin notes for the agent"
						onClick={() => setAnnotating((on) => !on)}
					>
						<MessageSquarePlus size={14} strokeWidth={1.75} />
						<span>Annotate</span>
					</button>
					<button
						type="button"
						className="canvas-mode-button"
						aria-pressed={comparing}
						title="Compare two revisions or canvases side by side"
						onClick={() => {
							setAnnotating(false);
							setCompare((current) =>
								current ? null : comparedWith(canvases, thread, shown),
							);
						}}
					>
						<Columns2 size={14} strokeWidth={1.75} />
						<span>Compare</span>
					</button>
				</div>
				<fieldset className="canvas-widths" aria-label="Preview width">
					{WIDTHS.map(({ id, label, icon: Icon }) => (
						<button
							key={id}
							type="button"
							aria-pressed={width === id}
							aria-label={label}
							title={label}
							className="canvas-icon-button"
							onClick={() => setWidth(id)}
						>
							<Icon size={14} strokeWidth={1.75} />
						</button>
					))}
				</fieldset>
				<button
					type="button"
					className="canvas-icon-button"
					aria-label="Open in new tab"
					title="Open in new tab"
					disabled={shown.html === null}
					onClick={() =>
						shown.html !== null && openStandalone(thread.title, shown.html)
					}
				>
					<ExternalLink size={14} strokeWidth={1.75} />
				</button>
			</header>
			{compare && compareThread ? (
				<div className="canvas-compare">
					<ComparePane
						canvases={canvases}
						thread={compareThread}
						shown={shownRevision(compareThread, compare.revision)}
						deviceWidth={preview.width}
						onPick={(title, revision) =>
							setCompare({
								title,
								...(revision === undefined ? {} : { revision }),
							})
						}
						onPrompt={prompt}
					/>
					<ComparePane
						canvases={canvases}
						thread={thread}
						shown={shown}
						deviceWidth={preview.width}
						onPick={pick}
						onPrompt={prompt}
					/>
				</div>
			) : shown.html === null ? (
				<NotKept />
			) : (
				<AnnotatedCanvas
					key={shown.id}
					canvas={shown}
					html={shown.html}
					isLatest={shown === latest}
					deviceWidth={preview.width}
					annotating={annotating}
					onAnnotatingChange={setAnnotating}
					onCompose={onCompose}
				/>
			)}
		</section>
	);
}

function NotKept() {
	return (
		<section className="inspector-empty" data-kind="canvas">
			<h2>This revision is no longer kept.</h2>
			<p>
				A chat keeps its newest canvas revisions; step to a newer one to see it.
			</p>
		</section>
	);
}

/** What the note box is open for: a new pin, or an existing note. */
type Composing =
	| { readonly kind: "new"; readonly pick: CanvasElementPick }
	| { readonly kind: "edit"; readonly id: string };

const PENDING_MARK = "pending";

/**
 * One canvas revision with its pins and notes: while annotating, a click in
 * the canvas drops a numbered pin and opens a note box beside it; the notes
 * list below edits, removes and sends them (into the message box, as one
 * message, for the user to send).
 */
function AnnotatedCanvas({
	canvas,
	html,
	isLatest,
	deviceWidth,
	annotating,
	onAnnotatingChange,
	onCompose,
}: {
	canvas: CanvasItem;
	html: string;
	isLatest: boolean;
	deviceWidth: number | null;
	annotating: boolean;
	onAnnotatingChange: (on: boolean) => void;
	onCompose?: Compose;
}) {
	const [notes, setNotes] = useCanvasNotes(canvas.id);
	const [composing, setComposing] = useState<Composing | null>(null);
	const [highlighted, setHighlighted] = useState<string | null>(null);
	const full = notes.length >= CANVAS_NOTES_LIMIT;
	// Escape in the app (not in a note box) stops annotating.
	useEffect(() => {
		if (!annotating) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				setComposing(null);
				onAnnotatingChange(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [annotating, onAnnotatingChange]);
	const marks: StageMark[] = notes.map((note, index) => ({
		key: note.id,
		label: String(index + 1),
		selector: note.pick.selector,
		fallback: note.pick.rect,
		active:
			highlighted === note.id ||
			(composing?.kind === "edit" && composing.id === note.id),
	}));
	if (composing?.kind === "new")
		marks.push({
			key: PENDING_MARK,
			label: String(notes.length + 1),
			selector: composing.pick.selector,
			fallback: composing.pick.rect,
			active: true,
		});
	const editing =
		composing?.kind === "edit"
			? notes.find((note) => note.id === composing.id)
			: undefined;
	const composerPick =
		composing?.kind === "new" ? composing.pick : editing?.pick;
	const composerNumber =
		composing?.kind === "new"
			? notes.length + 1
			: editing
				? notes.indexOf(editing) + 1
				: 0;
	const save = (text: string) => {
		if (composing?.kind === "new") {
			const pick = composing.pick;
			setNotes((current) => [
				...current,
				{ id: crypto.randomUUID(), pick, note: text },
			]);
		} else if (composing?.kind === "edit") {
			const id = composing.id;
			setNotes((current) =>
				current.map((note) =>
					note.id === id ? { ...note, note: text } : note,
				),
			);
		}
		setComposing(null);
	};
	const send = onCompose
		? () => {
				onCompose(
					canvasFeedbackMessage({
						title: canvas.title,
						revision: canvas.revision,
						notes,
					}),
					"append",
				);
				setNotes(() => []);
				setComposing(null);
				onAnnotatingChange(false);
			}
		: undefined;
	return (
		<>
			{annotating ? (
				<p className="canvas-annotate-hint" role="status">
					<span className="canvas-annotate-dot" aria-hidden="true" />
					{full
						? `This revision has ${CANVAS_NOTES_LIMIT} notes; send or remove some to add more.`
						: "Click any element to pin a note. Esc to stop."}
				</p>
			) : null}
			<CanvasStage
				html={html}
				title={canvas.title}
				deviceWidth={deviceWidth}
				annotating={annotating && !full}
				marks={marks}
				onPick={(pick) => setComposing({ kind: "new", pick })}
				onMarkClick={(key) =>
					key !== PENDING_MARK && setComposing({ kind: "edit", id: key })
				}
				onEscape={() => {
					setComposing(null);
					onAnnotatingChange(false);
				}}
				onPrompt={onCompose ? (text) => onCompose(text, "replace") : undefined}
				composer={
					composing && composerPick
						? {
								markKey: composing.kind === "new" ? PENDING_MARK : composing.id,
								node: (
									<NoteComposer
										key={
											composing.kind === "new"
												? composerPick.selector
												: composing.id
										}
										number={composerNumber}
										pick={composerPick}
										initial={editing?.note ?? ""}
										onSave={save}
										onCancel={() => setComposing(null)}
									/>
								),
							}
						: null
				}
			/>
			{notes.length || annotating ? (
				<CanvasNotesPanel
					notes={notes}
					revision={canvas.revision}
					isLatest={isLatest}
					onHighlight={setHighlighted}
					onEdit={(id, text) =>
						setNotes((current) =>
							current.map((note) =>
								note.id === id ? { ...note, note: text } : note,
							),
						)
					}
					onRemove={(id) =>
						setNotes((current) => current.filter((note) => note.id !== id))
					}
					onClear={() => setNotes(() => [])}
					onSend={send}
				/>
			) : null}
		</>
	);
}

/** One side of Compare: its own canvas and revision, the shared width. */
function ComparePane({
	canvases,
	thread,
	shown,
	deviceWidth,
	onPick,
	onPrompt,
}: {
	canvases: readonly CanvasThread[];
	thread: CanvasThread;
	shown: CanvasItem;
	deviceWidth: number | null;
	onPick: (title: string, revision?: number) => void;
	onPrompt?: (text: string) => void;
}) {
	return (
		<div className="canvas-compare-pane">
			<div className="canvas-compare-bar">
				<CanvasPicker
					canvases={canvases}
					current={thread.title}
					onPick={(title) => onPick(title)}
				/>
				<div className="canvas-inspector-spacer" />
				<RevisionStepper
					thread={thread}
					shown={shown}
					onStep={(revision) => onPick(thread.title, revision)}
				/>
			</div>
			{shown.html === null ? (
				<NotKept />
			) : (
				<CanvasStage
					key={shown.id}
					html={shown.html}
					title={`${thread.title}, revision ${shown.revision}`}
					deviceWidth={deviceWidth}
					annotating={false}
					marks={[]}
					onPrompt={onPrompt}
				/>
			)}
		</div>
	);
}

function RevisionStepper({
	thread,
	shown,
	onStep,
}: {
	thread: CanvasThread;
	shown: CanvasItem;
	onStep: (revision: number) => void;
}) {
	const position = thread.revisions.indexOf(shown);
	const latest = thread.revisions.at(-1) as CanvasItem;
	const step = (offset: number) => {
		const next = thread.revisions[position + offset];
		if (next) onStep(next.revision);
	};
	return (
		<fieldset className="canvas-revisions" aria-label="Revision">
			<button
				type="button"
				className="canvas-icon-button"
				aria-label="Previous revision"
				disabled={position <= 0}
				onClick={() => step(-1)}
			>
				<ChevronLeft size={14} strokeWidth={1.75} />
			</button>
			<span className="canvas-revision-label" aria-live="polite">
				rev {shown.revision}
				<span className="canvas-revision-total"> / {latest.revision}</span>
			</span>
			<button
				type="button"
				className="canvas-icon-button"
				aria-label="Next revision"
				disabled={position >= thread.revisions.length - 1}
				onClick={() => step(1)}
			>
				<ChevronRight size={14} strokeWidth={1.75} />
			</button>
		</fieldset>
	);
}

function CanvasPicker({
	canvases,
	current,
	onPick,
}: {
	canvases: readonly CanvasThread[];
	current: string;
	onPick: (title: string) => void;
}) {
	if (canvases.length < 2)
		return (
			<span className="canvas-picker" data-single="true" title={current}>
				{current}
			</span>
		);
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button type="button" className="canvas-picker" title={current}>
					<span className="canvas-picker-label">{current}</span>
					<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="recovery-menu inspector-view-menu"
					sideOffset={6}
					align="start"
				>
					{[...canvases].reverse().map((entry) => (
						<DropdownMenu.Item
							key={entry.title}
							data-selected={entry.title === current || undefined}
							onSelect={() => onPick(entry.title)}
						>
							<span className="menu-row-label">{entry.title}</span>
							<span className="canvas-picker-count">
								{entry.revisions.length > 1
									? `${entry.revisions.length} revs`
									: ""}
							</span>
							<span className="menu-row-check">
								{entry.title === current ? (
									<Check size={14} strokeWidth={1.5} aria-hidden="true" />
								) : null}
							</span>
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/**
 * Shows the canvas alone in a new tab: a scriptless page holding the same
 * sandboxed frame (canvasStandalonePage), from a short-lived blob URL.
 */
function openStandalone(title: string, html: string) {
	const url = URL.createObjectURL(
		new Blob([canvasStandalonePage(title, html)], { type: "text/html" }),
	);
	window.open(url, "_blank", "noopener,noreferrer");
	// The new tab has read it by then.
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
