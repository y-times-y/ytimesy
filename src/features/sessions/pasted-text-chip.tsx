import { FileText, X } from "lucide-react";
import { createContext, useContext, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	isPastedText,
	lineCount,
	PASTED_TEXT_MEDIA_TYPE,
	PASTED_TEXT_PREVIEW_CHARACTERS,
	pastedTextMeta,
	pastedTextName,
} from "#/domain/pasted-text";

export type PastedTextPreview = {
	readonly text: string;
	readonly truncated: boolean;
};

/** Loads a sent message's pasted text by attachment id. */
export const PastedTextReader = createContext<
	((attachmentId: string) => Promise<PastedTextPreview>) | null
>(null);

const textByFile = new WeakMap<File, string>();
// Sent this visit: the chip previews without a round trip.
const textBySentId = new Map<string, string>();

/** The attachment a large paste becomes; it travels like any attached file. */
export function pastedTextFile(text: string, number: number) {
	const file = new File([text], pastedTextName(number), {
		type: PASTED_TEXT_MEDIA_TYPE,
	});
	textByFile.set(file, text);
	return file;
}

export function pastedFileText(file: File) {
	return textByFile.get(file);
}

/** Keeps a sent paste's text for its chip in the transcript. */
export function rememberSentPaste(attachmentId: string, file: File) {
	const text = textByFile.get(file);
	if (text !== undefined) textBySentId.set(attachmentId, text);
}

/**
 * A sending paste as the transcript shows it: its line count, and its text
 * kept for the chip's preview. Other files add nothing.
 */
export function sentPasteFields(
	attachmentId: string,
	file: {
		readonly name: string;
		readonly mediaType: string;
		readonly base64: string;
	},
): { lines?: number } {
	if (!isPastedText(file)) return {};
	const bytes = Uint8Array.from(atob(file.base64), (char) =>
		char.charCodeAt(0),
	);
	const text = new TextDecoder().decode(bytes);
	textBySentId.set(attachmentId, text);
	return { lines: lineCount(text) };
}

function preview(text: string): PastedTextPreview {
	return {
		text: text.slice(0, PASTED_TEXT_PREVIEW_CHARACTERS),
		truncated: text.length > PASTED_TEXT_PREVIEW_CHARACTERS,
	};
}

/** A "Pasted text" chip; activating it previews the full text. */
export function PastedTextChip({
	text,
	attachmentId,
	lines,
	onRemove,
}: {
	/** Known text: a paste still in the composer. */
	text?: string;
	/** A sent paste, loaded on first open. */
	attachmentId?: string;
	lines?: number;
	onRemove?: () => void;
}) {
	const read = useContext(PastedTextReader);
	const [loaded, setLoaded] = useState<PastedTextPreview | null>(null);
	const [failed, setFailed] = useState(false);
	const known =
		text ?? (attachmentId ? textBySentId.get(attachmentId) : undefined);
	const shown = known === undefined ? loaded : preview(known);
	const meta = pastedTextMeta(
		lines ?? (known === undefined ? undefined : lineCount(known)),
	);

	function load(open: boolean) {
		if (!open || shown || !attachmentId || !read) return;
		setFailed(false);
		read(attachmentId).then(setLoaded, () => setFailed(true));
	}

	return (
		<li className="pasted-text-chip">
			<Popover onOpenChange={load}>
				<PopoverTrigger
					className="pasted-text-trigger"
					aria-label={`Pasted text${meta ? `, ${meta}` : ""}. Preview`}
				>
					<FileText size={14} strokeWidth={1.5} aria-hidden="true" />
					<span className="pasted-text-label">Pasted text</span>
					{meta ? <span className="pasted-text-meta">{meta}</span> : null}
				</PopoverTrigger>
				<PopoverContent
					side="top"
					align="start"
					collisionPadding={12}
					className="pasted-text-preview"
				>
					<div className="pasted-text-preview-title">
						<span>Pasted text</span>
						{meta ? <span className="pasted-text-meta">{meta}</span> : null}
					</div>
					{shown ? (
						<>
							<pre>{shown.text}</pre>
							{shown.truncated ? (
								<p className="pasted-text-preview-note">
									Showing the first{" "}
									{PASTED_TEXT_PREVIEW_CHARACTERS.toLocaleString("en")}{" "}
									characters
								</p>
							) : null}
						</>
					) : (
						<p className="pasted-text-preview-note">
							{failed || !read ? "Preview unavailable" : "Loading…"}
						</p>
					)}
				</PopoverContent>
			</Popover>
			{onRemove ? (
				<button
					type="button"
					className="pasted-text-remove"
					aria-label="Remove pasted text"
					onClick={onRemove}
				>
					<X size={14} />
				</button>
			) : null}
		</li>
	);
}
