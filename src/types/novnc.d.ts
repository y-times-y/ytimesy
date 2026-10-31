declare module "@novnc/novnc" {
	export default class RFB extends EventTarget {
		constructor(
			target: HTMLElement,
			/** A URL, or a WebSocket the caller opened (noVNC attaches to it). */
			urlOrChannel: string | WebSocket,
			options?: { readonly credentials?: { readonly password?: string } },
		);
		scaleViewport: boolean;
		clipViewport: boolean;
		resizeSession: boolean;
		showDotCursor: boolean;
		background: string;
		disconnect(): void;
	}
}
