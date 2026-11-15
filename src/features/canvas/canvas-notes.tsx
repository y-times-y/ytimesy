import { ArrowUp, X } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import {
	CANVAS_NOTE_LIMIT,
	type CanvasElementPick,
	type CanvasNote,
	canvasElementLabel,
} from "#/domain/canvas-annotation";
import { useAutoGrow } from "../app/use-auto-grow";

/** Enter saves, Shift+Enter is a new line, Escape cancels (and stays here). */
function noteKeys(
	event: KeyboardEvent<HTMLTextAreaElement>,
	save: () => void,
	cancel: () => void,
) {
	if (event.key === "Escape") {
		event.preventDefault();
		event.nativeEvent.stopImmediatePropagation();
		cancel();
	} else if (
		event.key === "Enter" &&
		!event.shiftKey &&
		!event.nativeEvent.isComposing
	) {
		event.preventDefault();
		save();
	}
}

/** The note box beside a pin: what should change about this element. */
export function NoteComposer({
	number,
	pick,
	initial,
	onSave,
	onCancel,
}: {
	number: number;
	pick: CanvasElementPick;
	initial: string;
	onSave: (note: string) => void;
	onCancel: () => void;
}) {
	const [text, setText] = useState(initial);
	const field = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(field, text);
	const save = () => {
		if (text.trim()) onSave(text.trim());
	};
	return (
		<form
			className="canvas-composer"
			aria-label={`Note ${number}`}
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<div className="canvas-composer-head">
				<span className="canvas-note-number" aria-hidden="true">
					{number}
				</span>
				<span className="canvas-composer-target" title={pick.selector}>
					{canvasElementLabel(pick)}
				</span>
			</div>
			<textarea
				ref={field}
				className="canvas-composer-input"
				// biome-ignore lint/a11y/noAutofocus: the note box opens for typing.
				autoFocus
				rows={3}
				maxLength={CANVAS_NOTE_LIMIT}
				placeholder="What should change here?"
				aria-label="Note"
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => noteKeys(event, save, onCancel)}
			/>
			<div className="canvas-composer-actions">
				<span className="canvas-composer-hint">↵ to add · Esc to cancel</span>
				<button type="button" className="canvas-text-button" onClick={onCancel}>
					Cancel
				</button>
				<button
					type="submit"
					className="canvas-primary-button"
					disabled={!text.trim()}
				>
					{initial ? "Save" : "Add note"}
				</button>
			</div>
		</form>
	);
}

/**
 * The pinned notes of the revision shown, in pin order: each editable and
 * removable, and Send, which puts them all in the message box as one
 * message (the user still sends it).
 */
export function CanvasNotesPanel({
	notes,
	revision,
	isLatest,
	onHighlight,
	onEdit,
	onRemove,
	onClear,
	onSend,
}: {
	notes: readonly CanvasNote[];
	revision: number;
	isLatest: boolean;
	onHighlight: (id: string | null) => void;
	onEdit: (id: string, note: string) => void;
	onRemove: (id: string) => void;
	onClear: () => void;
	/** Absent where there is no message box to send to. */
	onSend?: () => void;
}) {
	const count = notes.length === 1 ? "1 note" : `${notes.length} notes`;
	return (
		<section className="canvas-notes" aria-label="Notes">
			<header className="canvas-notes-head">
				<span className="canvas-notes-title">Notes</span>
				<span className="canvas-notes-meta">
					rev {revision}
					{isLatest ? "" : " · older revision"}
				</span>
				<div className="canvas-inspector-spacer" />
				{notes.length ? (
					<button
						type="button"
						className="canvas-text-button"
						onClick={onClear}
					>
						Clear
					</button>
				) : null}
			</header>
			{notes.length ? (
				<ol className="canvas-notes-list">
					{notes.map((note, index) => (
						<NoteRow
							key={note.id}
							number={index + 1}
							note={note}
							onHighlight={onHighlight}
							onEdit={(text) => onEdit(note.id, text)}
							onRemove={() => onRemove(note.id)}
						/>
					))}
				</ol>
			) : (
				<p className="canvas-notes-empty">
					Pinned notes collect here. Send them together when you are done.
				</p>
			)}
			<footer className="canvas-notes-foot">
				<span className="canvas-notes-hint">
					{onSend
						? "Goes into your message box; you send it."
						: "Open this chat to send notes."}
				</span>
				<button
					type="button"
					className="canvas-primary-button"
					disabled={!notes.length || !onSend}
					onClick={onSend}
				>
					Send {count}
					<ArrowUp size={14} strokeWidth={2} aria-hidden="true" />
				</button>
			</footer>
		</section>
	);
}

function NoteRow({
	number,
	note,
	onHighlight,
	onEdit,
	onRemove,
}: {
	number: number;
	note: CanvasNote;
	onHighlight: (id: string | null) => void;
	onEdit: (text: string) => void;
	onRemove: () => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const editField = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(editField, draft ?? "");
	const save = () => {
		if (draft?.trim()) onEdit(draft.trim());
		setDraft(null);
	};
	return (
		<li
			className="canvas-note"
			onMouseEnter={() => onHighlight(note.id)}
			onMouseLeave={() => onHighlight(null)}
			onFocus={() => onHighlight(note.id)}
			onBlur={() => onHighlight(null)}
		>
			<span className="canvas-note-number" aria-hidden="true">
				{number}
			</span>
			<div className="canvas-note-body">
				<span className="canvas-note-target" title={note.pick.selector}>
					{canvasElementLabel(note.pick)}
				</span>
				{draft === null ? (
					<button
						type="button"
						className="canvas-note-text"
						title="Edit note"
						onClick={() => setDraft(note.note)}
					>
						{note.note}
					</button>
				) : (
					<textarea
						ref={editField}
						className="canvas-composer-input"
						// biome-ignore lint/a11y/noAutofocus: editing was just asked for.
						autoFocus
						rows={2}
						maxLength={CANVAS_NOTE_LIMIT}
						aria-label={`Note ${number}`}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => noteKeys(event, save, () => setDraft(null))}
						onBlur={save}
					/>
				)}
			</div>
			<button
				type="button"
				className="canvas-icon-button canvas-note-remove"
				aria-label={`Remove note ${number}`}
				title="Remove"
				onClick={onRemove}
			>
				<X size={13} strokeWidth={1.75} />
			</button>
		</li>
	);
}
