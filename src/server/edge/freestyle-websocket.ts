import { EventEmitter } from "node:events";
import type {
	Response as WorkerResponse,
	WebSocket as WorkerWebSocket,
} from "@cloudflare/workers-types";
import { webSocketCloseReason } from "../sockets/close-reason";

/** Freestyle's Node-shaped PTY client needs authenticated upgrades, not browser WebSocket(). */
export default class FreestyleWorkerWebSocket extends EventEmitter {
	readyState = 0;
	private socket?: WorkerWebSocket;
	private readonly abort = new AbortController();
	private readonly pending: { event: string; args: unknown[] }[] = [];
	private pendingBytes = 0;

	constructor(url: string, options: { headers: Record<string, string> }) {
		super();
		this.on("newListener", () => queueMicrotask(() => this.flushPending()));
		void this.connect(url, options.headers).catch((error: unknown) => {
			if (this.readyState === 3) return;
			this.readyState = 3;
			const rejected =
				error instanceof Error &&
				/^PTY upgrade rejected \([0-9]{3}\)\.$/.test(error.message);
			const category =
				error instanceof Error
					? error.message.includes("AbortSignal") ||
						/abort.*signal|signal.*websocket/i.test(error.message)
						? "abort-signal"
						: /redirect/i.test(error.message)
							? "redirect"
							: /fetch/i.test(error.message)
								? "fetch"
								: /secure/i.test(error.message)
									? "insecure-url"
									: /websocket|upgrade/i.test(error.message)
										? "websocket"
										: "transport"
					: "transport";
			this.deliver(
				"error",
				new Error(
					rejected
						? error.message
						: `Freestyle PTY upgrade failed (${category}).`,
				),
			);
		});
	}

	private async connect(url: string, headers: Record<string, string>) {
		const endpoint = new URL(url);
		if (endpoint.protocol !== "wss:") throw new Error("Secure PTY required.");
		endpoint.protocol = "https:";
		const response = (await fetch(endpoint, {
			headers: { ...headers, Upgrade: "websocket" },
			redirect: "manual",
			signal: this.abort.signal,
		})) as WorkerResponse;
		const socket = response.webSocket;
		if (response.status !== 101 || !socket) {
			await response.body?.cancel();
			throw new Error(`PTY upgrade rejected (${response.status}).`);
		}
		if (this.readyState === 3) {
			socket.accept();
			socket.close();
			return;
		}
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			const binary = typeof event.data !== "string";
			this.deliver(
				"message",
				binary ? new Uint8Array(event.data) : event.data,
				binary,
			);
		});
		socket.addEventListener("close", (event) => {
			this.readyState = 3;
			this.deliver("close", {
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
			});
		});
		socket.addEventListener("error", () =>
			this.deliver("error", new Error("Freestyle PTY connection failed.")),
		);
		socket.accept();
		this.readyState = 1;
		this.emit("open");
	}

	private deliver(event: string, ...args: unknown[]) {
		if (this.listenerCount(event)) {
			this.emit(event, ...args);
			return;
		}
		const payload = args[0];
		this.pendingBytes +=
			typeof payload === "string"
				? new TextEncoder().encode(payload).byteLength
				: payload instanceof Uint8Array
					? payload.byteLength
					: 0;
		if (this.pendingBytes > 1024 * 1024) {
			this.close();
			throw new Error("PTY opening output exceeded its buffer limit.");
		}
		this.pending.push({ event, args });
	}

	private flushPending() {
		while (this.pending.length) {
			const next = this.pending[0];
			if (!next || !this.listenerCount(next.event)) break;
			this.pending.shift();
			this.emit(next.event, ...next.args);
		}
		if (!this.pending.length) this.pendingBytes = 0;
	}

	send(data: string | Uint8Array) {
		if (!this.socket || this.readyState !== 1)
			throw new Error("PTY is not open.");
		this.socket.send(data);
	}

	close(code?: number, reason?: string) {
		if (!this.socket) {
			this.readyState = 3;
			this.abort.abort();
			return;
		}
		this.readyState = 2;
		this.socket.close(code, webSocketCloseReason(reason));
	}
}
