import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	openLiveProgress,
	resetLiveProgressSocketOffer,
} from "./live-progress-connection";

const sessionId = "00000000-0000-4000-8000-000000000077";
type Listener = (event: { data: string; lastEventId: string }) => void;
type TestSocket = {
	send: ReturnType<typeof vi.fn<() => void>>;
	close: ReturnType<typeof vi.fn<() => void>>;
	onopen: (() => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
};
type TestStream = {
	url: string;
	readyState: number;
	close: ReturnType<typeof vi.fn<() => void>>;
	onopen: (() => void) | null;
	onerror: (() => void) | null;
	addEventListener(name: string, listener: Listener): void;
	listeners: Record<string, Listener>;
};
function fixture() {
	const sockets: TestSocket[] = [];
	const streams: TestStream[] = [];
	const onProgress = vi.fn();
	const onPreview = vi.fn();
	const stop = openLiveProgress({
		projectId: "project",
		sessionId,
		location: { protocol: "https:", host: "example.test" },
		onProgress,
		onPreview,
		onOpen: vi.fn(),
		onDrop: vi.fn(),
		createSocket: () => {
			const socket: TestSocket = {
				send: vi.fn(),
				close: vi.fn(),
				onopen: null,
				onclose: null,
				onmessage: null,
				onerror: null,
			};
			sockets.push(socket);
			return socket;
		},
		createEventSource: (url) => {
			const listeners: Record<string, Listener> = {};
			const stream: TestStream = {
				url,
				readyState: 1,
				close: vi.fn(),
				onopen: null,
				onerror: null,
				addEventListener: (name: string, listener: Listener) => {
					listeners[name] = listener;
				},
				listeners,
			};
			streams.push(stream);
			return stream;
		},
	});
	return { sockets, streams, onProgress, onPreview, stop };
}
const progress = {
	sessionId,
	items: [{ id: "alpha", kind: "agentMessage", text: "first" }],
	turnStatus: "running",
	window: { itemsRev: "2", first: 0, end: 1, hidden: [] },
};
const delta = {
	sessionId,
	baseItemsRev: "2",
	window: { itemsRev: "3", first: 0, end: 2 },
	rows: [
		{ position: 1, item: { id: "beta", kind: "agentMessage", text: "second" } },
	],
	queued: [],
	hasOlderItems: false,
	turnStatus: "running",
};
beforeEach(() => {
	vi.useFakeTimers();
	resetLiveProgressSocketOffer();
});
afterEach(() => vi.useRealTimers());
it("merges socket deltas and stops all reconnects when disposed", () => {
	const f = fixture();
	const socket = f.sockets[0];
	socket.onopen?.();
	socket.onmessage?.({ data: JSON.stringify({ revision: "10", progress }) });
	socket.onmessage?.({ data: JSON.stringify({ revision: "11", delta }) });
	expect(f.onProgress.mock.calls[1][1].items).toHaveLength(2);
	f.stop();
	vi.advanceTimersByTime(120000);
	expect(f.sockets).toHaveLength(1);
	expect(socket.close).toHaveBeenCalled();
});
it("falls back to delta-enabled SSE when sockets are not offered", () => {
	const f = fixture();
	f.sockets[0].onclose?.({ code: 4001 });
	const stream = f.streams[0];
	expect(stream.url).toContain("deltas=1");
	stream.listeners.progress({
		lastEventId: "10",
		data: JSON.stringify(progress),
	});
	stream.listeners.delta({ lastEventId: "11", data: JSON.stringify(delta) });
	expect(f.onProgress.mock.calls[1][1].items).toHaveLength(2);
	f.stop();
});
it("reconnects for a full snapshot when a socket delta is missed", () => {
	const f = fixture();
	const socket = f.sockets[0];
	socket.onmessage?.({ data: JSON.stringify({ revision: "11", delta }) });
	expect(f.onProgress).not.toHaveBeenCalled();
	vi.advanceTimersByTime(10000);
	expect(f.sockets.length).toBeGreaterThan(1);
	f.stop();
});
it("hands preview frames over a delivered copy to the page, never as progress", () => {
	const f = fixture();
	const socket = f.sockets[0];
	socket.onopen?.();
	const preview = {
		type: "preview",
		turnId: "22222222-2222-4222-8222-222222222222",
		events: [{ type: "text-delta", id: "cc-0-0", text: "Working on it." }],
	};
	// Before the first snapshot there is nothing to show it in.
	socket.onmessage?.({ data: JSON.stringify(preview) });
	expect(f.onPreview).not.toHaveBeenCalled();
	socket.onmessage?.({ data: JSON.stringify({ revision: "10", progress }) });
	socket.onmessage?.({ data: JSON.stringify(preview) });
	expect(f.onPreview).toHaveBeenCalledWith(preview);
	expect(f.onProgress).toHaveBeenCalledTimes(1);
	// A later delta still applies on the same copy.
	socket.onmessage?.({ data: JSON.stringify({ revision: "11", delta }) });
	expect(f.onProgress.mock.calls[1][1].items).toHaveLength(2);
	f.stop();
});
