/** Ports our own guest services hold; never offered as previews. */
const RESERVED_PORTS = new Set([22, 53, 5900, 6080, 9222]);
/** Linux's ephemeral range: listen(0) services (our tool service among them), not user apps. */
const EPHEMERAL_PORT_FLOOR = 32768;

export const LIST_LISTENING_PORTS = "ss -ltnH";

export type PreviewPort = {
	readonly port: number;
	/**
	 * Bound to loopback only. The edge delivers to the VM's network interface,
	 * so the app must listen on 0.0.0.0 (or ::) before its preview can load.
	 */
	readonly loopbackOnly: boolean;
};

export type PreviewPortView = PreviewPort & {
	/** Public link when the owner turned sharing on for this port. */
	readonly shareUrl: string | null;
};

export type WorkspacePreviews =
	| { readonly status: "unavailable"; readonly reason: string }
	| { readonly status: "asleep" }
	| { readonly status: "ready"; readonly ports: readonly PreviewPortView[] };

export function previewPortAllowed(port: number) {
	return (
		Number.isInteger(port) &&
		port >= 1 &&
		port < EPHEMERAL_PORT_FLOOR &&
		!RESERVED_PORTS.has(port)
	);
}

/** Parses `ss -ltnH` (State Recv-Q Send-Q Local:Port Peer:Port …) into user-app ports. */
export function parseListeningPorts(output: string): PreviewPort[] {
	const ports = new Map<number, boolean>();
	for (const line of output.split("\n")) {
		const local = line.trim().split(/\s+/)[3];
		const match = local && /^(.*):(\d+)$/.exec(local);
		if (!match) continue;
		const port = Number(match[2]);
		if (!previewPortAllowed(port)) continue;
		const loopback = /^(127\.|\[::1\]|::1$|localhost)/.test(match[1] ?? "");
		ports.set(port, (ports.get(port) ?? true) && loopback);
	}
	return [...ports]
		.sort(([a], [b]) => a - b)
		.map(([port, loopbackOnly]) => ({ port, loopbackOnly }));
}
