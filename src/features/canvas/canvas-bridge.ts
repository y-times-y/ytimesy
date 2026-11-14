import { type RefObject, useCallback, useEffect, useRef } from "react";
import {
	annotateMessage,
	type CanvasFrameMessage,
	canvasMessageFromFrame,
	trackMessage,
} from "#/domain/canvas-annotation";

/**
 * Whether the page has had a click or key press in the last few seconds.
 * A click inside the canvas frame activates its ancestors too; a browser
 * without the API (rare by now) is taken at its word.
 */
function pageHasUserActivation() {
	const activation = (
		navigator as Navigator & { userActivation?: { isActive: boolean } }
	).userActivation;
	return activation ? activation.isActive : true;
}

/**
 * The app's side of one canvas frame's bridge (CANVAS_BRIDGE_SCRIPT): hands
 * on messages that pass canvasMessageFromFrame (from this frame only, exact
 * shapes, a real click for pins and prompts) and tells the frame whether
 * to annotate and which elements to report positions of. Returns the sync,
 * for the frame's load (a reloaded document starts with neither).
 */
export function useCanvasBridge(
	frame: RefObject<HTMLIFrameElement | null>,
	state: {
		readonly annotating: boolean;
		readonly selectors: readonly string[];
		readonly onMessage: (message: CanvasFrameMessage) => void;
	},
) {
	const onMessage = useRef(state.onMessage);
	onMessage.current = state.onMessage;
	useEffect(() => {
		const listener = (event: MessageEvent) => {
			const message = canvasMessageFromFrame(
				event,
				frame.current?.contentWindow ?? null,
				pageHasUserActivation(),
			);
			if (message) onMessage.current(message);
		};
		window.addEventListener("message", listener);
		return () => window.removeEventListener("message", listener);
	}, [frame]);
	const { annotating } = state;
	const selectorKey = state.selectors.join("\n");
	// biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the list.
	const sync = useCallback(() => {
		const target = frame.current?.contentWindow;
		if (!target) return;
		// The frame's origin is opaque, so no narrower target origin exists;
		// these say only whether to annotate and what to locate.
		target.postMessage(annotateMessage(annotating), "*");
		target.postMessage(trackMessage(state.selectors), "*");
	}, [frame, annotating, selectorKey]);
	useEffect(sync, [sync]);
	return sync;
}
