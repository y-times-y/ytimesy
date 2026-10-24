import { FileText, ImageIcon, Paperclip, X } from "lucide-react";
import { createContext, type ReactNode, useContext, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	attachmentKindLabel,
	attachmentSizeLabel,
} from "#/domain/message-attachment";
import {
	isPastedText,
	PASTED_TEXT_MEDIA_TYPE,
	PASTED_TEXT_PREVIEW_CHARACTERS,
	pastedTextFields,
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
// Sent this visit: the tile previews without a round trip.
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

/**
 * A sending paste as the transcript shows it: its line count and first lines,
 * with its text kept for the preview. Other files add nothing.
 */
export function sentPasteFields(
	attachmentId: string,
	file: {
		readonly name: string;
		readonly mediaType: string;
		readonly base64: string;
	},
): { lines?: number; peek?: string } {
	if (!isPastedText(file)) return {};
	const bytes = Uint8Array.from(atob(file.base64), (char) =>
		char.charCodeAt(0),
	);
	const text = new TextDecoder().decode(bytes);
	textBySentId.set(attachmentId, text);
	return pastedTextFields(text);
}

/** The same for a composer file, before it is encoded. */
export function sentFileFields(
	attachmentId: string,
	file: File,
): { lines?: number; peek?: string } {
	const text = textByFile.get(file);
	if (text === undefined) return {};
	textBySentId.set(attachmentId, text);
	return pastedTextFields(text);
}

function preview(text: string): PastedTextPreview {
	return {
		text: text.slice(0, PASTED_TEXT_PREVIEW_CHARACTERS),
		truncated: text.length > PASTED_TEXT_PREVIEW_CHARACTERS,
	};
}

function Tile({
	kind,
	label,
	onRemove,
	children,
}: {
	kind: "pasted" | "file";
	label: string;
	onRemove?: () => void;
	children: ReactNode;
}) {
	return (
		<li className="attachment-tile" data-attachment={kind}>
			{children}
			{onRemove ? (
				<button
					type="button"
					className="attachment-tile-remove"
					aria-label={`Remove ${label}`}
					title="Remove"
					onClick={onRemove}
				>
					<X size={12} strokeWidth={2} aria-hidden="true" />
				</button>
			) : null}
		</li>
	);
}

/** A large paste: its first lines, faint; activating it previews the text. */
export function PastedTextTile({
	text,
	attachmentId,
	lines,
	peek,
	onRemove,
}: {
	/** Known text: a paste still in the composer. */
	text?: string;
	/** A sent paste, loaded on first open. */
	attachmentId?: string;
	lines?: number;
	peek?: string;
	onRemove?: () => void;
}) {
	const read = useContext(PastedTextReader);
	const [loaded, setLoaded] = useState<PastedTextPreview | null>(null);
	const [failed, setFailed] = useState(false);
	const known =
		text ?? (attachmentId ? textBySentId.get(attachmentId) : undefined);
	const shown = known === undefined ? loaded : preview(known);
	const fields = known === undefined ? null : pastedTextFields(known);
	const meta = pastedTextMeta(lines ?? fields?.lines);
	const firstLines = peek ?? fields?.peek ?? "";

	function load(open: boolean) {
		if (!open || shown || !attachmentId || !read) return;
		setFailed(false);
		read(attachmentId).then(setLoaded, () => setFailed(true));
	}

	return (
		<Tile kind="pasted" label="pasted text" onRemove={onRemove}>
			<Popover onOpenChange={load}>
				<PopoverTrigger
					className="attachment-tile-body"
					aria-label={`Pasted text${meta ? `, ${meta}` : ""}. Preview`}
				>
					<span className="attachment-tile-peek" aria-hidden="true">
						{firstLines}
					</span>
					<span className="attachment-tile-label">
						<FileText size={12} strokeWidth={1.5} aria-hidden="true" />
						<span>Pasted{meta ? ` · ${meta}` : ""}</span>
					</span>
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
		</Tile>
	);
}

/** Any other attached file: its name over its type and size. */
export function FileTile({
	name,
	mediaType,
	size,
	onRemove,
}: {
	name: string;
	mediaType: string;
	size: number;
	onRemove?: () => void;
}) {
	const Icon = mediaType.startsWith("image/") ? ImageIcon : Paperclip;
	return (
		<Tile kind="file" label={name} onRemove={onRemove}>
			<div className="attachment-tile-body" title={name}>
				<span className="attachment-tile-name">{name}</span>
				<span className="attachment-tile-label">
					<Icon size={12} strokeWidth={1.5} aria-hidden="true" />
					<span>
						{attachmentKindLabel(name, mediaType)} · {attachmentSizeLabel(size)}
					</span>
				</span>
			</div>
		</Tile>
	);
}
