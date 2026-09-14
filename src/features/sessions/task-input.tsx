import { type KeyboardEvent, useEffect, useRef } from "react";

function fitDraftHeight(input: HTMLTextAreaElement) {
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
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
		<textarea
			ref={inputRef}
			aria-label={label}
			placeholder={placeholder}
			rows={1}
			value={value}
			disabled={disabled}
			onChange={(event) => {
				onChange(event.currentTarget.value);
				fitDraftHeight(event.currentTarget);
			}}
			onInput={(event) => fitDraftHeight(event.currentTarget)}
			onKeyDown={(event) => {
				if (onKeyDown?.(event)) return;
				if (event.key === "Enter" && !event.shiftKey) {
					event.preventDefault();
					onSubmit();
				}
			}}
		/>
	);
}
