import {
	type LivePreviewMessage,
	parseLivePreview,
} from "#/domain/claude-feed-preview";
import { createLiveProgressCopy } from "#/domain/live-progress";
import {
	LIVE_PROGRESS_PATH,
	LIVE_SOCKET_CLOSE,
	LIVE_SOCKET_PING,
	LIVE_SOCKET_PONG,
	type LiveProgressMessage,
} from "#/domain/live-progress-socket";
import { progressReopenDelayMs } from "#/domain/session-progress";

/** How often the browser pings; the chat's object answers without waking. */
export const LIVE_SOCKET_PING_MS = 30_000;
/** Nothing heard (not even a pong) for this long: the socket is dead. */
export const LIVE_SOCKET_SILENCE_MS = 75_000;
/**
 * Sockets in a row that never delivered a snapshot before this connection
 * switches to the event stream (a proxy that blocks WebSockets, a server
 * without the route).
 */
export const SOCKET_FAILURES_BEFORE_STREAM = 2;

type SocketLike = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onerror: (() => void) | null;
};
type EventSourceLike = {
	readonly readyState: number;
	close(): void;
	onopen: (() => void) | null;
	onerror: (() => void) | null;
	addEventListener(
		type: "progress" | "delta",
		listener: (event: { data: string; lastEventId: string }) => void,
	): void;
};
const EVENT_SOURCE_CLOSED = 2;

export type LiveProgressOptions = {
	projectId: string;
	sessionId: string;
	/** A whole snapshot of the chat, newest last; revisions only grow. */
	onProgress(revision: string, progress: unknown): void;
	/**
	 * Text a running Claude Code turn wrote that its step has not published
	 * yet (claude-feed-preview.ts): shown until a snapshot carries it. Only
	 * the socket carries previews.
	 */
	onPreview?(preview: LivePreviewMessage): void;
	/** The connection delivers (its first snapshot arrived, or the stream opened). */
	onOpen(): void;
	/** It stopped delivering; it reconnects by itself. */
	onDrop(): void;
	location?: { protocol: string; host: string };
	createSocket?: (url: string) => SocketLike;
	createEventSource?: (url: string) => EventSourceLike;
};

/**
 * Set for the rest of the page once the server said it does not offer the
 * socket (YTIMESY_LIVE_WS off): later chats open the stream directly.
 */
let socketNotOffered = false;
export function resetLiveProgressSocketOffer() {
	socketNotOffered = false;
}

export function liveProgressUrls(
	location: { protocol: string; host: string },
	projectId: string,
	sessionId: string,
) {
	const query = new URLSearchParams({ projectId, sessionId });
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return {
		socket: `${scheme}//${location.host}${LIVE_PROGRESS_PATH}?${query}`,
		stream: `/api/agent/progress?${query}&deltas=1`,
	};
}

/**
 * The open chat's live progress: a WebSocket when the server offers one, else
 * the older event stream. Either reconnects with backoff, and every
 * (re)connect starts with a whole snapshot, so a missed push is never lost.
 * Returns the function that closes it for good.
 */
export function openLiveProgress(options: LiveProgressOptions): () => void {
	const urls = liveProgressUrls(
		options.location ?? window.location,
		options.projectId,
		options.sessionId,
	);
	const createSocket =
		options.createSocket ??
		((url: string) => new WebSocket(url) as unknown as SocketLike);
	const createEventSource =
		options.createEventSource ??
		((url: string) => new EventSource(url) as unknown as EventSourceLike);
	let closed = false;
	let attempt = 0;
	let failedSockets = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let stopCurrent = () => {};

	const reconnect = (delayMs: number) => {
		if (closed) return;
		clearTimeout(retry);
		retry = setTimeout(() => {
			retry = undefined;
			connect();
		}, delayMs);
	};
	const connect = () => {
		if (closed) return;
		if (socketNotOffered || failedSockets >= SOCKET_FAILURES_BEFORE_STREAM)
			openStream();
		else openSocket();
	};

	const openSocket = () => {
		const socket = createSocket(urls.socket);
		const copy = createLiveProgressCopy(options.sessionId);
		let delivering = false;
		let heardAt = Date.now();
		let ping: ReturnType<typeof setInterval> | undefined;
		const detach = () => {
			clearInterval(ping);
			socket.onopen = null;
			socket.onmessage = null;
			socket.onclose = null;
			socket.onerror = null;
		};
		const end = (code: number | null) => {
			detach();
			try {
				socket.close();
			} catch {}
			if (closed) return;
			if (delivering) options.onDrop();
			if (code === LIVE_SOCKET_CLOSE.notOffered) {
				socketNotOffered = true;
				connect();
				return;
			}
			if (!delivering && ++failedSockets >= SOCKET_FAILURES_BEFORE_STREAM) {
				connect();
				return;
			}
			reconnect(
				code === LIVE_SOCKET_CLOSE.reauthorize
					? 0
					: progressReopenDelayMs(attempt++),
			);
		};
		stopCurrent = () => {
			detach();
			try {
				socket.close(1000);
			} catch {}
		};
		socket.onopen = () => {
			heardAt = Date.now();
			ping = setInterval(() => {
				if (Date.now() - heardAt > LIVE_SOCKET_SILENCE_MS) {
					end(null);
					return;
				}
				try {
					socket.send(LIVE_SOCKET_PING);
				} catch {}
			}, LIVE_SOCKET_PING_MS);
		};
		socket.onmessage = (event) => {
			heardAt = Date.now();
			if (typeof event.data !== "string" || event.data === LIVE_SOCKET_PONG)
				return;
			let message: LiveProgressMessage;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			if (typeof message?.revision !== "string") {
				// Previews only over a copy this socket delivered.
				const preview = delivering ? parseLivePreview(message) : null;
				if (preview) options.onPreview?.(preview);
				return;
			}
			const progress = message.delta
				? copy.delta(message.delta)
				: copy.full(message.progress);
			if (progress === "resync") {
				end(null);
				return;
			}
			if (!progress) return;
			if (!delivering) {
				delivering = true;
				attempt = 0;
				failedSockets = 0;
				options.onOpen();
			}
			options.onProgress(message.revision, progress);
		};
		socket.onclose = (event) => end(event.code);
	};

	const openStream = () => {
		const source = createEventSource(urls.stream);
		const copy = createLiveProgressCopy(options.sessionId);
		source.addEventListener("delta", (event) => {
			let data: unknown;
			try {
				data = JSON.parse(event.data);
			} catch {
				data = null;
			}
			const progress = copy.delta(data);
			if (progress === "resync" || data === null) {
				source.close();
				options.onDrop();
				reconnect(0);
			} else if (progress) options.onProgress(event.lastEventId, progress);
		});
		source.addEventListener("progress", (event) => {
			let progress: unknown;
			try {
				progress = JSON.parse(event.data);
			} catch {
				return;
			}
			const next = copy.full(progress);
			if (next) options.onProgress(event.lastEventId, next);
		});
		source.onopen = () => {
			attempt = 0;
			options.onOpen();
		};
		source.onerror = () => {
			options.onDrop();
			// The browser retries by itself unless the reconnect was refused.
			if (source.readyState === EVENT_SOURCE_CLOSED && !retry) {
				source.close();
				reconnect(progressReopenDelayMs(attempt++));
			}
		};
		stopCurrent = () => source.close();
	};

	connect();
	return () => {
		closed = true;
		clearTimeout(retry);
		stopCurrent();
	};
}
