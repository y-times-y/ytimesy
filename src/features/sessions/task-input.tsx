import {
	type ClipboardEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useRef,
} from "react";
import { COMPOSER_DRAFT_SCRIPT, useHydrated } from "../app/first-paint";
import { fitDraftHeight } from "./fit-draft-height";

/**
 * Enter sends; Shift+Enter is a newline. An Enter that confirms an input
 * method (IME) candidate belongs to the IME, not the composer.
 */
export function enterSubmits(event: {
	readonly key: string;
	readonly shiftKey: boolean;
	readonly keyCode?: number;
	readonly nativeEvent?: { readonly isComposing?: boolean };
}) {
	if (event.key !== "Enter" || event.shiftKey) return false;
	// Safari reports the composition-ending Enter as keyCode 229 only.
	return !event.nativeEvent?.isComposing && event.keyCode !== 229;
}

export function TaskInput({
	value,
	onChange,
	onSubmit,
	disabled,
	placeholder = "What would you like to work on?",
	label = "Task description",
	onKeyDown,
	onCaretChange,
	onPaste,
	textareaRef,
	id,
	draftKey,
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	disabled?: boolean;
	placeholder?: string;
	label?: string;
	onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
	/** The caret moved: typing, clicks and arrow keys. */
	onCaretChange?: (caret: number) => void;
	onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
	id?: string;
	/**
	 * The chat whose saved draft (src/domain/composer-drafts.ts) the server's
	 * textarea shows from the first paint, filled in by an inline script.
	 */
	draftKey?: string;
}) {
	const hydrated = useHydrated();
	const inputRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const input = inputRef.current;
		if (input && input.value === value) fitDraftHeight(input);
	}, [value]);

	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		let previousWidth = 0;
		const observer = new ResizeObserver(([entry]) => {
			if (entry.contentRect.width === previousWidth) return;
			previousWidth = entry.contentRect.width;
			fitDraftHeight(input);
		});
		observer.observe(input);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="composer-input">
			<textarea
				id={id}
				ref={(node) => {
					inputRef.current = node;
					if (textareaRef) textareaRef.current = node;
				}}
				data-draft-key={draftKey}
				// The draft script may fill and size the server's textarea before hydration.
				suppressHydrationWarning={draftKey !== undefined}
				aria-label={label}
				placeholder={placeholder}
				rows={1}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					onChange(event.currentTarget.value);
					onCaretChange?.(event.currentTarget.selectionStart);
				}}
				onPaste={onPaste}
				onSelect={(event) =>
					onCaretChange?.(event.currentTarget.selectionStart)
				}
				onKeyDown={(event) => {
					if (onKeyDown?.(event)) return;
					if (enterSubmits(event)) {
						event.preventDefault();
						onSubmit();
					}
				}}
			/>
			{draftKey !== undefined && !hydrated ? (
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: our own constant script, no user input.
					dangerouslySetInnerHTML={{ __html: COMPOSER_DRAFT_SCRIPT }}
					suppressHydrationWarning
				/>
			) : null}
		</div>
	);
}
