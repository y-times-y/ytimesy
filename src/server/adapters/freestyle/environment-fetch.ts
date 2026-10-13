type EnvironmentRequestCounts = {
	requests: number;
	backgroundPolls: number;
};

/** Keep SDK recovery intact; allow ordinary infrastructure calls to finish inline. */
export function environmentFreestyleFetch(
	counts: EnvironmentRequestCounts,
	transport: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
	return (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		if (url.origin === "https://api.freestyle.sh") {
			counts.requests++;
			if (url.pathname.startsWith("/v5/background-requests/"))
				counts.backgroundPolls++;
			if (headers.has("x-freestyle-background-after-secs"))
				headers.set("x-freestyle-background-after-secs", "30");
		}
		return transport(input, { ...init, headers });
	};
}
