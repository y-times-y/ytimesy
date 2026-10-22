import {
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
} from "react";
import {
	type MentionAgent,
	mentionSegments,
	mentionTokenBefore,
} from "#/domain/agent-mentions";
import { MentionMirror, syncMirror } from "./mention-mirror";

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
	textareaRef,
	mentions,
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
	textareaRef?: RefObject<HTMLTextAreaElement | null>;
	/** Agents the draft can mention: each "@name" shows its icon in place of the "@". */
	mentions?: readonly MentionAgent[];
}) {
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const mirrorRef = useRef<HTMLDivElement>(null);
	const agents = useMemo(
		() =>
			new Map(
				(mentions ?? []).map((agent) => [agent.name.toLowerCase(), agent]),
			),
		[mentions],
	);
	const known = (name: string) => agents.has(name.toLowerCase());
	const segments =
		agents.size && value.includes("@")
			? mentionSegments(value, (name) => agents.has(name.toLowerCase()))
			: [];
	const mirrored = segments.some((segment) => segment.kind === "mention");
	const sync = () => {
		const input = inputRef.current;
		const mirror = mirrorRef.current;
		if (input && mirror) syncMirror(input, mirror);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: Each draft refits the height, then the mirror follows it.
	useEffect(() => {
		const input = inputRef.current;
		if (input && input.value === value) fitDraftHeight(input);
		sync();
	}, [value]);
	// Before paint, so the mirror never shows a frame out of place.
	useLayoutEffect(sync);

	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		let previousWidth = 0;
		const observer = new ResizeObserver(([entry]) => {
			const mirror = mirrorRef.current;
			if (mirror) syncMirror(input, mirror);
			if (entry.contentRect.width === previousWidth) return;
			previousWidth = entry.contentRect.width;
			fitDraftHeight(input);
		});
		observer.observe(input);
		return () => observer.disconnect();
	}, []);

	return (
		<div className="composer-input">
			<div className="composer-field">
				{mirrored ? (
					<MentionMirror ref={mirrorRef} segments={segments} agents={agents} />
				) : null}
				<textarea
					data-mentions={mirrored ? "true" : undefined}
					onScroll={sync}
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
					onSelect={(event) =>
						onCaretChange?.(event.currentTarget.selectionStart)
					}
					onKeyDown={(event) => {
						if (onKeyDown?.(event)) return;
						// Backspace right after a mention takes all of it; the
						// deletion stays native, so undo brings it back.
						const input = event.currentTarget;
						if (
							event.key === "Backspace" &&
							!event.altKey &&
							!event.metaKey &&
							!event.ctrlKey &&
							input.selectionStart === input.selectionEnd
						) {
							const start = mentionTokenBefore(
								input.value,
								input.selectionStart,
								known,
							);
							if (start !== null)
								input.setSelectionRange(start, input.selectionStart);
						}
						if (enterSubmits(event)) {
							event.preventDefault();
							onSubmit();
						}
					}}
				/>
			</div>
		</div>
	);
}
