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
