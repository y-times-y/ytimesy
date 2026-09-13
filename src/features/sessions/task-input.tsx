import { useEffect, useRef } from "react";

function fitDraftHeight(input: HTMLTextAreaElement) {
	input.style.height = "auto";
	input.style.height = `${input.scrollHeight}px`;
}

export function TaskInput() {
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
			aria-label="Task description"
			placeholder="What would you like to work on?"
			rows={2}
			onInput={(event) => fitDraftHeight(event.currentTarget)}
		/>
	);
}
