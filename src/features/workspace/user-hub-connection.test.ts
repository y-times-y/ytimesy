import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_TURN_POLL_MS } from "#/domain/harness-access";
import { LIVE_SOCKET_CLOSE } from "#/domain/live-progress-socket";
import type { SessionTurnStatus } from "#/domain/session-item";
import { hubStateMessage, USER_HUB_PING_MS } from "#/domain/user-hub";
import {
	backgroundTurnPollIntervalMs,
	HUB_FAILURES_BEFORE_POLLING,
	hubReadsToMake,
	openUserHub,
} from "./user-hub-connection";

describe("backgroundTurnPollIntervalMs", () => {
	it("polls exactly as before without the hub, never with it", () => {
		expect(backgroundTurnPollIntervalMs(false)).toBe(BACKGROUND_TURN_POLL_MS);
		expect(backgroundTurnPollIntervalMs(true)).toBe(false);
	});
});

describe("hubReadsToMake", () => {
	const sidebar = new Map<string, SessionTurnStatus | undefined>([
		["bg", "running"],
		["bg2", "running"],
		["idle", "completed"],
		["open", "running"],
	]);
	const base = {
		sidebarStatuses: sidebar,
		backgroundChatIds: ["bg", "bg2"],
		openChatId: "open",
	};
	it("reads a background chat once its turn settles", () => {
		expect(
			hubReadsToMake({
				...base,
				message: { type: "state", chats: { bg: { turnStatus: "completed" } } },
			}),
		).toEqual({ reads: ["bg"], refreshList: false });
	});
	it("reads the chat list when an idle chat starts running", () => {
		expect(
			hubReadsToMake({
				...base,
				message: { type: "state", chats: { idle: { turnStatus: "running" } } },
			}),
		).toEqual({ reads: [], refreshList: true });
	});
	it("leaves the open chat and chats outside the sidebar alone", () => {
		expect(
			hubReadsToMake({
				...base,
				message: {
					type: "state",
					chats: {
						open: { turnStatus: "completed" },
						elsewhere: { turnStatus: "running" },
					},
				},
			}),
		).toEqual({ reads: [], refreshList: false });
	});
	it("on a whole map, reads background chats it does not show running", () => {
		expect(
			hubReadsToMake({
				...base,
				message: {
					type: "state",
					full: true,
					chats: { bg: { turnStatus: "running" } },
				},
			}),
		).toEqual({ reads: ["bg2"], refreshList: false });
	});
	it("a change alone does not read chats it does not mention", () => {
		expect(
			hubReadsToMake({
				...base,
				message: { type: "state", chats: {} },
			}),
		).toEqual({ reads: [], refreshList: false });
	});
});

class FakeSocket {
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
}

describe("openUserHub", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	const location = { protocol: "https:", host: "example.test" };
	function harness() {
		const sockets: FakeSocket[] = [];
		const events: string[] = [];
		const close = openUserHub({
			location,
			createSocket: (url) => {
				expect(url).toBe("wss://example.test/api/user/live");
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			onState: (message) =>
				events.push(`state:${message.full ? "full" : "change"}`),
			onOpen: () => events.push("open"),
			onDrop: () => events.push("drop"),
		});
		return { sockets, events, close };
	}

	it("opens on the whole map, then passes changes", () => {
		const { sockets, events } = harness();
		sockets[0].onopen?.();
		sockets[0].onmessage?.({ data: hubStateMessage({}, true) });
		sockets[0].onmessage?.({
			data: hubStateMessage({ a: { turnStatus: "running" } }),
		});
		expect(events).toEqual(["open", "state:full", "state:change"]);
	});

	it("pings every 120 seconds", () => {
		const { sockets } = harness();
		sockets[0].onopen?.();
		vi.advanceTimersByTime(USER_HUB_PING_MS - 1);
		expect(sockets[0].sent).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(sockets[0].sent).toEqual(["ping"]);
	});

	it("drops and reconnects with a resync after a delivering socket closes", () => {
		const { sockets, events } = harness();
		sockets[0].onmessage?.({ data: hubStateMessage({}, true) });
		sockets[0].onclose?.({ code: 1006 });
		expect(events).toEqual(["open", "state:full", "drop"]);
		vi.advanceTimersByTime(20_000);
		expect(sockets).toHaveLength(2);
		sockets[1].onmessage?.({ data: hubStateMessage({}, true) });
		expect(events.slice(3)).toEqual(["open", "state:full"]);
	});

	it("gives up for the page after sockets in a row that never delivered", () => {
		const { sockets } = harness();
		for (let index = 0; index < HUB_FAILURES_BEFORE_POLLING; index++) {
			sockets[index].onclose?.({ code: 1006 });
			vi.advanceTimersByTime(20_000);
		}
		expect(sockets).toHaveLength(HUB_FAILURES_BEFORE_POLLING);
	});

	it("stops when the server does not offer it", () => {
		const { sockets } = harness();
		sockets[0].onclose?.({ code: LIVE_SOCKET_CLOSE.notOffered });
		vi.advanceTimersByTime(60_000);
		expect(sockets).toHaveLength(1);
	});

	it("closing it for good stops reconnects", () => {
		const { sockets, close } = harness();
		sockets[0].onmessage?.({ data: hubStateMessage({}, true) });
		close();
		expect(sockets[0].closed).toBe(true);
		vi.advanceTimersByTime(60_000);
		expect(sockets).toHaveLength(1);
	});
});
