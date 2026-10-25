/** Sizes the composer to its text. Self-contained: the first-paint draft script inlines it. */
export function fitDraftHeight(input: HTMLTextAreaElement) {
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
