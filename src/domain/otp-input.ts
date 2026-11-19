/**
 * The editing rules of a code typed into one box per digit
 * (src/components/ui/otp-input.tsx), as pure functions so they can be tested
 * without a browser. The value is the digits typed so far with no gaps: the
 * boxes fill from the left, a box past the end sends the caret to the first
 * empty one, and deleting a digit closes the gap.
 *
 * Each edit returns the new value and the box that should have the caret.
 */
export type OtpEdit = { readonly value: string; readonly focus: number };

export const OTP_LENGTH = 6;

/** Only the digits of what was typed or pasted, at most `length` of them. */
export function otpDigits(text: string, length = OTP_LENGTH) {
	return text.replace(/\D/g, "").slice(0, length);
}

/** The box the caret goes to after `value` is set: the first empty one, or the last. */
function caretAfter(value: string, length: number) {
	return Math.min(value.length, length - 1);
}

/** The box a click or a tab should really land on: no gaps, so never past the first empty one. */
export function otpBoxFor(value: string, index: number, length = OTP_LENGTH) {
	return Math.min(index, value.length, length - 1);
}

/**
 * Digits pasted (or filled in by the phone's one-time-code suggestion, which
 * arrives as a whole code in one box) starting at `index`. A whole code
 * replaces what was there; a part is added where the caret is.
 */
export function pasteInto(
	value: string,
	index: number,
	text: string,
	length = OTP_LENGTH,
): OtpEdit {
	const digits = otpDigits(text, length);
	if (!digits) return { value, focus: otpBoxFor(value, index, length) };
	const at = digits.length === length ? 0 : Math.min(index, value.length);
	const next = (value.slice(0, at) + digits).slice(0, length);
	return { value: next, focus: caretAfter(next, length) };
}

/** What a box now holds after the person typed into box `index`. */
export function typeInto(
	value: string,
	index: number,
	raw: string,
	length = OTP_LENGTH,
): OtpEdit {
	const typed = raw.replace(/\D/g, "");
	if (!typed) return { value, focus: otpBoxFor(value, index, length) };
	const old = value[index];
	// A digit typed over a digit leaves both in the box: keep the new one.
	if (typed.length === 2 && old !== undefined && typed.includes(old)) {
		const fresh = typed.replace(old, "");
		return typeInto(value, index, fresh, length);
	}
	if (typed.length > 1) return pasteInto(value, index, typed, length);
	const at = Math.min(index, value.length);
	const next = (value.slice(0, at) + typed + value.slice(at + 1)).slice(
		0,
		length,
	);
	// On to the next box, also when a digit in the middle was typed over.
	return { value: next, focus: Math.min(at + 1, length - 1) };
}

/** Backspace in box `index`: clears its digit, or the one before when it is empty. */
export function backspaceAt(value: string, index: number): OtpEdit {
	if (index < value.length)
		return {
			value: value.slice(0, index) + value.slice(index + 1),
			focus: index,
		};
	if (value.length === 0) return { value, focus: 0 };
	return { value: value.slice(0, -1), focus: value.length - 1 };
}

/** Delete in box `index`: clears its digit and keeps the caret there. */
export function deleteAt(value: string, index: number): OtpEdit {
	if (index >= value.length) return { value, focus: index };
	return {
		value: value.slice(0, index) + value.slice(index + 1),
		focus: index,
	};
}
