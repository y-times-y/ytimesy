import { WebSocket } from "ws";
import type { ClientSocket } from "./client-socket";
import { webSocketCloseReason } from "./close-reason";

/** Adapts a `ws` socket (local Node dev server) to the shared session code. */
export function nodeClientSocket(socket: WebSocket): ClientSocket {
	return {
		get open() {
			return socket.readyState === WebSocket.OPEN;
		},
		send: (data) => socket.send(data),
		close: (code, reason) => socket.close(code, webSocketCloseReason(reason)),
		onMessage: (listener) =>
			socket.on("message", (raw, binary) =>
				listener(binary ? toBytes(raw) : raw.toString(), binary),
			),
		onClose: (listener) => {
			socket.on("close", listener);
			socket.on("error", listener);
		},
	};
}

export function openNodeRemoteSocket(url: string) {
	return new Promise<ClientSocket>((resolve, reject) => {
		const remote = new WebSocket(url, ["binary"]);
		const timer = setTimeout(() => {
			remote.terminate();
			reject(new Error("Desktop is not ready."));
		}, 8_000);
		remote.once("open", () => {
			clearTimeout(timer);
			resolve(nodeClientSocket(remote));
		});
		remote.once("error", (cause) => {
			clearTimeout(timer);
			reject(cause);
		});
	});
}

function toBytes(raw: WebSocket.RawData): Uint8Array {
	if (Array.isArray(raw)) return Buffer.concat(raw);
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	return new Uint8Array(raw);
}
