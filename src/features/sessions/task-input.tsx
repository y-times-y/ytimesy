import { type KeyboardEvent, useEffect, useRef } from "react";

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
}: {
	value: string;
	onChange: (value: string) => void;
	onSubmit: () => void;
	disabled?: boolean;
	placeholder?: string;
	label?: string;
	onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
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
				ref={inputRef}
				aria-label={label}
				placeholder={placeholder}
				rows={1}
				value={value}
				disabled={disabled}
				onChange={(event) => {
					onChange(event.currentTarget.value);
				}}
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
