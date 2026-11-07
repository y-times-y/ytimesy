import { Client } from "tunnelfetch";

/** A request owns its TLS connection until its response is consumed or cancelled. */
export async function codexTunnelFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const target = new URL(input instanceof Request ? input.url : String(input));
	if (
		target.origin !== "https://chatgpt.com" ||
		!target.pathname.startsWith("/backend-api/")
	) {
		throw new Error("Codex tunnel destination is not allowed.");
	}
	const proxy = process.env.YTIMESY_CODEX_TUNNEL_URL;
	if (!proxy) throw new Error("Codex tunnel is not configured.");
	const { connect } = await import("cloudflare:sockets");
	const client = new Client({
		connect: (address, options) => {
			const hostname = address.hostname;
			return connect(
				{
					...address,
					hostname:
						hostname.includes(":") && !hostname.startsWith("[")
							? `[${hostname}]`
							: hostname,
				},
				{
					secureTransport: options?.secureTransport ?? "off",
					allowHalfOpen: options?.allowHalfOpen ?? false,
				},
			);
		},
		proxy,
		trust: { mode: "system" },
		timeouts: { idleMs: 0, totalMs: 0 },
	});
	try {
		const response = await client.fetch(input, { ...init, redirect: "manual" });
		if (!response.body) {
			await client.close();
			return response;
		}
		const reader = response.body.getReader();
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						await client.close();
					} else controller.enqueue(next.value);
				} catch (error) {
					controller.error(error);
					await client.close();
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await client.close();
				}
			},
		});
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		await client.close();
		throw error;
	}
}
