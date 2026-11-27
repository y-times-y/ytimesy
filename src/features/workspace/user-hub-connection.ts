import { BACKGROUND_TURN_POLL_MS } from "#/domain/harness-access";
import {
	LIVE_SOCKET_CLOSE,
	LIVE_SOCKET_PING,
} from "#/domain/live-progress-socket";
import { isTurnRunning, type SessionTurnStatus } from "#/domain/session-item";
import { progressReopenDelayMs } from "#/domain/session-progress";
import {
	type HubStateMessage,
	parseHubStateMessage,
	USER_HUB_PATH,
	USER_HUB_PING_MS,
	USER_HUB_SILENCE_MS,
} from "#/domain/user-hub";

/**
 * Sockets in a row that never delivered the hub's state before this page
 * stops trying and keeps polling (the route is off for this user, a proxy
 * blocks WebSockets).
 */
export const HUB_FAILURES_BEFORE_POLLING = 3;

/**
 * A tab that was away this long may have slept through pushes: its socket can
 * look open while the phone or laptop slept (the silence check runs every two
 * minutes, on a timer a hidden tab throttles). Coming back, the page asks the
 * socket for an answer; none within HUB_PROBE_REPLY_MS and it reconnects, which
 * starts with the whole map and so re-reads what was missed.
 */
export const HUB_PROBE_AFTER_AWAY_MS = 15_000;
export const HUB_PROBE_REPLY_MS = 5_000;

/** The browser's returns to the page: shown again, restored from the back-forward cache, back online. */
function browserReturns(wake: (awayMs: number) => void) {
	if (typeof document === "undefined") return () => {};
	let hiddenAt: number | null = null;
	const onVisibility = () => {
		if (document.visibilityState === "hidden") {
			hiddenAt = Date.now();
			return;
		}
		const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
		hiddenAt = null;
		wake(away);
	};
	const onPageShow = (event: PageTransitionEvent) => {
		if (event.persisted) wake(Number.POSITIVE_INFINITY);
	};
	const onOnline = () => wake(Number.POSITIVE_INFINITY);
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pageshow", onPageShow);
	window.addEventListener("online", onOnline);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("pageshow", onPageShow);
		window.removeEventListener("online", onOnline);
	};
}

/** How often running chats in the background are read: never while the hub pushes. */
export function backgroundTurnPollIntervalMs(hubOpen: boolean): number | false {
	return hubOpen ? false : BACKGROUND_TURN_POLL_MS;
}

/**
 * What one hub message asks the page to read. `reads`: background chats
 * (the ones polled without the hub) whose turn the hub says is no longer
 * running, or, on a whole-map message (a (re)connect), that it does not
 * know as running. `refreshList`: a chat the sidebar shows idle is running
 * now, so the chat list is read again (it then joins the background chats).
 * Chats outside the sidebar and the open chat (its own live socket) are
 * left alone, as polling left them.
 */
export function hubReadsToMake(input: {
	readonly message: HubStateMessage;
	readonly sidebarStatuses: ReadonlyMap<string, SessionTurnStatus | undefined>;
	readonly backgroundChatIds: readonly string[];
	readonly openChatId?: string;
}): { reads: string[]; refreshList: boolean } {
	const { message } = input;
	const reads = new Set<string>();
	let refreshList = false;
	for (const [id, { turnStatus }] of Object.entries(message.chats)) {
		if (id === input.openChatId || !input.sidebarStatuses.has(id)) continue;
		if (isTurnRunning(turnStatus)) {
			if (!isTurnRunning(input.sidebarStatuses.get(id) ?? "idle"))
				refreshList = true;
		} else {
			// Settled: the sidebar's status (finished, needs you) changed too.
			if (isTurnRunning(input.sidebarStatuses.get(id) ?? "idle"))
				refreshList = true;
			if (input.backgroundChatIds.includes(id)) reads.add(id);
		}
	}
	if (message.full)
		for (const id of input.backgroundChatIds)
			if (!isTurnRunning(message.chats[id]?.turnStatus ?? "idle"))
				reads.add(id);
	return { reads: [...reads], refreshList };
}

type SocketLike = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onerror: (() => void) | null;
};

export type UserHubOptions = {
	/** A state message: the whole map first on every (re)connect, then changes. */
	onState(message: HubStateMessage): void;
	/** The socket delivers (its first state arrived). */
	onOpen(): void;
	/** It stopped delivering; it reconnects by itself unless it gave up. */
	onDrop(): void;
	location?: { protocol: string; host: string };
	createSocket?: (url: string) => SocketLike;
	/** Tells when the person is back after `awayMs` (the browser's events by default). */
	watchReturn?: (wake: (awayMs: number) => void) => () => void;
};

export function userHubUrl(location: { protocol: string; host: string }) {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}${USER_HUB_PATH}`;
}

/**
 * The signed-in user's hub socket. Reconnects with backoff, and every
 * (re)connect starts with the whole map, so a missed push is caught up.
 * Gives up for the page after HUB_FAILURES_BEFORE_POLLING sockets in a row
 * that never delivered, or when the server does not offer it. Returns the
 * function that closes it for good.
 */
export function openUserHub(options: UserHubOptions): () => void {
	const url = userHubUrl(options.location ?? window.location);
	const createSocket =
		options.createSocket ??
		((target: string) => new WebSocket(target) as unknown as SocketLike);
	let closed = false;
	let attempt = 0;
	let failedSockets = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let stopCurrent = () => {};
	let probeCurrent = () => {};

	const connect = () => {
		if (closed) return;
		const socket = createSocket(url);
		let delivering = false;
		let heardAt = Date.now();
		let heardCount = 0;
		let ping: ReturnType<typeof setInterval> | undefined;
		let probeTimer: ReturnType<typeof setTimeout> | undefined;
		const detach = () => {
			clearInterval(ping);
			clearTimeout(probeTimer);
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
			if (code === LIVE_SOCKET_CLOSE.notOffered) return;
			if (!delivering && ++failedSockets >= HUB_FAILURES_BEFORE_POLLING) return;
			const delay =
				code === LIVE_SOCKET_CLOSE.reauthorize
					? 0
					: progressReopenDelayMs(attempt++);
			retry = setTimeout(() => {
				retry = undefined;
				connect();
			}, delay);
		};
		stopCurrent = () => {
			detach();
			try {
				socket.close(1000);
			} catch {}
		};
		// Back after a while: is the socket still alive? Silence means it slept.
		probeCurrent = () => {
			if (!delivering || probeTimer !== undefined) return;
			const before = heardCount;
			try {
				socket.send(LIVE_SOCKET_PING);
			} catch {
				end(null);
				return;
			}
			probeTimer = setTimeout(() => {
				probeTimer = undefined;
				if (heardCount === before) end(null);
			}, HUB_PROBE_REPLY_MS);
		};
		socket.onopen = () => {
			heardAt = Date.now();
			ping = setInterval(() => {
				if (Date.now() - heardAt > USER_HUB_SILENCE_MS) {
					end(null);
					return;
				}
				try {
					socket.send(LIVE_SOCKET_PING);
				} catch {}
			}, USER_HUB_PING_MS);
		};
		socket.onmessage = (event) => {
			heardAt = Date.now();
			heardCount += 1;
			const message = parseHubStateMessage(event.data);
			if (!message) return;
			if (!delivering) {
				// Only a whole map opens it: changes alone could miss one.
				if (!message.full) return;
				delivering = true;
				attempt = 0;
				failedSockets = 0;
				options.onOpen();
			}
			options.onState(message);
		};
		socket.onclose = (event) => end(event.code);
	};

	connect();
	const stopWatching = (options.watchReturn ?? browserReturns)((awayMs) => {
		if (closed || awayMs < HUB_PROBE_AFTER_AWAY_MS) return;
		if (retry !== undefined) {
			// A reconnect waiting on a timer a hidden tab slowed: do it now.
			clearTimeout(retry);
			retry = undefined;
			connect();
			return;
		}
		probeCurrent();
	});
	return () => {
		closed = true;
		clearTimeout(retry);
		stopWatching();
		stopCurrent();
	};
}
