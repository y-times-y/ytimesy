import {
	type ClipboardEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useRef,
} from "react";

function fitDraftHeight(input: HTMLTextAreaElement) {
	input.style.height = "auto";
	if (!input.value) {
		input.dataset.expanded = "false";
		return;
	}
	if (input.value && input.scrollHeight > 36) {
		input.dataset.expanded = "true";
	}
	input.style.height = `${input.scrollHeight}px`;
}

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
}) {
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
				ref={(node) => {
					inputRef.current = node;
					if (textareaRef) textareaRef.current = node;
				}}
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
		</div>
	);
}
