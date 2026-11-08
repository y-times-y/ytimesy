import { useEffect, useRef, useState } from "react";
import { revealedLength, type TextArrival } from "#/domain/smooth-reveal";

/**
 * A streaming reply's text as it should show: new text is held back and
 * revealed at a steady pace (revealedLength) instead of in the bursts the
 * progress stream delivers. Text present when it mounts shows at once, and
 * the whole text shows the moment the reply stops streaming or the tab is
 * hidden. Settled replies get their text unchanged.
 */
export function useSmoothText(text: string, streaming: boolean): string {
	const [shown, setShown] = useState(text.length);
	const state = useRef({
		shown: text.length,
		text,
		arrivals: [] as TextArrival[],
		/** When the last snapshot with new text arrived, and a running mean of the gaps. */
		lastArrival: 0,
		cadence: 0,
	});
	const frame = useRef(0);
	useEffect(() => {
		const current = state.current;
		const replaced = !text.startsWith(current.text.slice(0, current.shown));
		current.text = text;
		if (!streaming || replaced || document.hidden) {
			current.shown = text.length;
			current.arrivals = [];
			current.lastArrival = 0;
			current.cadence = 0;
			setShown(text.length);
			return;
		}
		if (text.length <= current.shown) return;
		const arrivedAt = performance.now();
		if (current.lastArrival) {
			const gap = Math.min(arrivedAt - current.lastArrival, 5_000);
			current.cadence = current.cadence
				? current.cadence * 0.6 + gap * 0.4
				: gap;
		}
		current.lastArrival = arrivedAt;
		current.arrivals.push({ end: text.length, at: arrivedAt });
		if (frame.current) return;
		let last = performance.now();
		const step = (now: number) => {
			const next = revealedLength({
				text: current.text,
				shown: current.shown,
				arrivals: current.arrivals,
				now,
				elapsed: now - last,
				cadence: current.cadence,
			});
			last = now;
			current.shown = next;
			current.arrivals = current.arrivals.filter(
				(arrival) => arrival.end > next,
			);
			setShown(next);
			frame.current =
				next < current.text.length ? requestAnimationFrame(step) : 0;
		};
		frame.current = requestAnimationFrame(step);
	}, [text, streaming]);
	useEffect(() => {
		if (!streaming) return;
		const flush = () => {
			if (!document.hidden) return;
			cancelAnimationFrame(frame.current);
			frame.current = 0;
			state.current.shown = state.current.text.length;
			state.current.arrivals = [];
			setShown(state.current.text.length);
		};
		document.addEventListener("visibilitychange", flush);
		return () => document.removeEventListener("visibilitychange", flush);
	}, [streaming]);
	useEffect(() => () => cancelAnimationFrame(frame.current), []);
	return streaming ? text.slice(0, shown) : text;
}
