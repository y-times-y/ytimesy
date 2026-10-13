/** The browser side of a terminal or desktop socket, on Node (`ws`) or Workers. */
export interface ClientSocket {
	readonly open: boolean;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	onMessage(
		listener: (data: string | Uint8Array, binary: boolean) => void,
	): void;
	onClose(listener: () => void): void;
}

/** A WebSocket to a VM service (the desktop's VNC proxy). */
export type RemoteSocket = ClientSocket;
