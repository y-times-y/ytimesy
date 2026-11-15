import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Sizes a text box to what it holds. The CSS max-height (half the screen,
 * styles.css) stops it growing; past that it scrolls. Handles both box models:
 * the height the style sets is the border box's or the content box's.
 */
export function growToFit(element: HTMLTextAreaElement) {
	element.style.height = "auto";
	const style = getComputedStyle(element);
	const borderBox = style.boxSizing === "border-box";
	const borders = element.offsetHeight - element.clientHeight;
	const padding =
		Number.parseFloat(style.paddingTop) +
		Number.parseFloat(style.paddingBottom);
	const height = borderBox
		? element.scrollHeight + borders
		: element.scrollHeight - padding;
	element.style.height = `${Math.max(0, Math.ceil(height))}px`;
}

/**
 * Keeps a text box as tall as its text, so no native drag-to-resize grip is
 * needed (and none is shown: see `textarea` in styles.css). Refits after every
 * render (the box may have mounted since, as an edit box does, and the value
 * is what changes its height) and when its width changes (a panel resized, the
 * text wraps differently).
 */
export function useAutoGrow(
	ref: RefObject<HTMLTextAreaElement | null>,
	value: string,
) {
	const watching = useRef<{ element: HTMLTextAreaElement; stop: () => void }>(
		null,
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs after every render on purpose; `value` is listed so the intent shows.
	useLayoutEffect(() => {
		const element = ref.current;
		if (element) growToFit(element);
		if (watching.current?.element === element) return;
		watching.current?.stop();
		watching.current = null;
		if (!element || typeof ResizeObserver === "undefined") return;
		let width = element.clientWidth;
		const observer = new ResizeObserver(() => {
			if (element.clientWidth === width) return;
			width = element.clientWidth;
			growToFit(element);
		});
		observer.observe(element);
		watching.current = { element, stop: () => observer.disconnect() };
	}, [value, ref]);
	useEffect(
		() => () => {
			watching.current?.stop();
			watching.current = null;
		},
		[],
	);
}
