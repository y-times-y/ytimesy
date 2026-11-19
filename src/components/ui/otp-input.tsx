import { cn } from "cn";
import {
	type ClipboardEvent,
	type KeyboardEvent,
	useImperativeHandle,
	useRef,
} from "react";
import { Input } from "#/components/ui/input.tsx";
import {
	backspaceAt,
	deleteAt,
	OTP_LENGTH,
	otpBoxFor,
	pasteInto,
	typeInto,
} from "#/domain/otp-input";

export type OtpInputHandle = { focus: () => void };

/**
 * A code typed one digit per box. The editing rules are in
 * src/domain/otp-input.ts; this wires them to the boxes:
 *
 * - typing a digit moves to the next box, Backspace clears and goes back,
 *   the arrow keys move, Home and End jump to the first and last box;
 * - pasting a code (or the phone offering the one from the email, which
 *   arrives as a whole code in the first box) fills every box at once;
 * - the first box carries `autocomplete="one-time-code"` and every box a
 *   numeric keyboard, so phones suggest the emailed code and show digits;
 * - the boxes fill from the left: a click past the end lands on the first
 *   empty box.
 */
export function OtpInput({
	value,
	onChange,
	length = OTP_LENGTH,
	disabled,
	invalid,
	autoFocus,
	label = "Code",
	handle,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	length?: number;
	disabled?: boolean;
	invalid?: boolean;
	autoFocus?: boolean;
	/** What a screen reader calls the whole code. */
	label?: string;
	/** Lets the page put the caret back in the first box after a wrong code. */
	handle?: React.Ref<OtpInputHandle>;
	className?: string;
}) {
	const boxes = useRef<(HTMLInputElement | null)[]>([]);
	// The newest value, which a fast second keystroke must see before React
	// has drawn the first one: edits and focus moves read this, not the prop.
	const latest = useRef(value);
	latest.current = value;
	const focusBox = (index: number) => {
		const box = boxes.current[index];
		box?.focus();
		box?.select();
	};
	useImperativeHandle(
		handle,
		() => ({
			focus: () => {
				boxes.current[0]?.focus();
				boxes.current[0]?.select();
			},
		}),
		[],
	);

	const apply = (edit: { value: string; focus: number }) => {
		const changed = edit.value !== latest.current;
		latest.current = edit.value;
		if (changed) onChange(edit.value);
		// At once, not a frame later: the next key goes to the box that has the
		// caret, and that must already be the right one.
		focusBox(edit.focus);
	};

	function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
		switch (event.key) {
			case "Backspace":
				event.preventDefault();
				apply(backspaceAt(latest.current, index));
				return;
			case "Delete":
				event.preventDefault();
				apply(deleteAt(latest.current, index));
				return;
			case "ArrowLeft":
				event.preventDefault();
				focusBox(Math.max(0, index - 1));
				return;
			case "ArrowRight":
				event.preventDefault();
				focusBox(otpBoxFor(latest.current, index + 1, length));
				return;
			case "Home":
				event.preventDefault();
				focusBox(0);
				return;
			case "End":
				event.preventDefault();
				focusBox(otpBoxFor(latest.current, length - 1, length));
				return;
		}
	}

	function onPaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
		event.preventDefault();
		apply(
			pasteInto(
				latest.current,
				index,
				event.clipboardData.getData("text"),
				length,
			),
		);
	}

	return (
		<fieldset
			className={cn(
				"m-0 flex w-full min-w-0 justify-center gap-1.5 border-0 p-0 sm:gap-2",
				className,
			)}
		>
			<legend className="sr-only">{label}</legend>
			{Array.from({ length }, (_, index) => (
				<Input
					// biome-ignore lint/suspicious/noArrayIndexKey: the boxes are fixed positions
					key={index}
					ref={(element) => {
						boxes.current[index] = element;
					}}
					value={value[index] ?? ""}
					onChange={(event) =>
						apply(typeInto(latest.current, index, event.target.value, length))
					}
					onKeyDown={(event) => onKeyDown(index, event)}
					onPaste={(event) => onPaste(index, event)}
					onFocus={(event) => {
						// No gaps: a box past the end hands the caret to the first empty one.
						const target = otpBoxFor(latest.current, index, length);
						if (target !== index) focusBox(target);
						else event.target.select();
					}}
					onClick={(event) => event.currentTarget.select()}
					inputMode="numeric"
					pattern="[0-9]*"
					// The first box only: phones suggest the emailed code there and
					// hand it over whole, which pasteInto spreads across the boxes.
					autoComplete={index === 0 ? "one-time-code" : "off"}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					aria-label={`Digit ${index + 1} of ${length}`}
					aria-invalid={invalid ? true : undefined}
					autoFocus={autoFocus && index === 0}
					disabled={disabled}
					className={cn(
						"h-12 min-w-0 max-w-11 flex-1 rounded-lg px-0 text-center font-mono text-xl font-medium caret-transparent md:text-xl",
						// A little air between the two groups of three.
						index === Math.ceil(length / 2) - 1 && "mr-1 sm:mr-2",
						value[index] ? "border-foreground/30 bg-input/40" : undefined,
					)}
				/>
			))}
		</fieldset>
	);
}
