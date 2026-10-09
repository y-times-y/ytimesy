import { UnsupportedEdgeModelEndpoint } from "../../domain/api-turn-failure";
import { DIRECT_MODEL_ENDPOINTS } from "../../domain/browse-models";
import {
	MODEL_PROVIDERS,
	publicModelEndpoint,
} from "../../domain/model-connection";
import { withModelEndpointFactory } from "../adapters/model-endpoint";

const officialEndpoints = new Set([
	...Object.values(DIRECT_MODEL_ENDPOINTS),
	...Object.values(MODEL_PROVIDERS).flatMap((provider) =>
		provider.baseUrl ? [provider.baseUrl] : [],
	),
]);

/** Native fetch for fixed provider endpoints; custom DNS/socket enforcement remains Node-only. */
export function edgeModelEndpointTransport(
	baseUrl: string,
	transport: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
) {
	const endpoint = publicModelEndpoint(baseUrl);
	if (!officialEndpoints.has(endpoint))
		throw new UnsupportedEdgeModelEndpoint();
	const allowed = new URL(endpoint);
	const apiPath = allowed.pathname.replace(/\/+$/, "");
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, { ...init, redirect: "manual" });
		const target = new URL(request.url);
		if (
			target.origin !== allowed.origin ||
			target.username ||
			target.password ||
			!(
				target.pathname === apiPath || target.pathname.startsWith(`${apiPath}/`)
			)
		)
			throw new Error("Model endpoint origin or API path changed.");
		const response = await transport(request, {
			redirect: "manual",
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(120_000)]),
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			throw new Error("Model endpoint redirect refused.");
		}
		return response;
	};
	return { fetch, close: async () => {} };
}

export function withEdgeModelEndpoints<T>(run: () => T): T {
	return withModelEndpointFactory(edgeModelEndpointTransport, run);
}
