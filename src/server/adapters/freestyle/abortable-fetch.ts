import { machineCallSignal } from "#/server/services/machine-call-signal";

/**
 * Every request made inside a turn's machine call carries that call's
 * signal (machine-call-signal.ts); requests outside one are unchanged.
 */
export function callSignalFetch(transport: typeof fetch): typeof fetch {
	return async (request, init) => {
		const callSignal = machineCallSignal();
		if (!callSignal) return transport(request, init);
		return abortableFreestyleFetch(callSignal, transport)(request, init);
	};
}

/** SDK background polls omit the initial request signal; retain it across the entire operation. */
export function abortableFreestyleFetch(
	operationSignal: AbortSignal,
	transport: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
	return async (request, init) => {
		const requestSignal =
			init?.signal ?? (request instanceof Request ? request.signal : undefined);
		const signal = requestSignal
			? AbortSignal.any([operationSignal, requestSignal])
			: operationSignal;
		signal.throwIfAborted();
		return transport(request, { ...init, signal });
	};
}
