import { FreestyleApiError } from "freestyle";

const BACKGROUND_AFTER_HEADER = "x-freestyle-background-after-secs";
const BACKGROUND_ID_HEADER = "x-freestyle-background-request-id";
const POLL_PREFIX = "/v5/background-requests/";

/** Past its background window a request answers 202 at once; this bounds a stalled connection. */
const REQUEST_GRACE_MS = 60_000;
/** A poll answers immediately (result or another 202). */
const POLL_REQUEST_MS = 60_000;
/** File bytes in or out, which do not background. */
const TRANSFER_MS = 300_000;
/** Reads, starts, pauses, updates, deletes. A read may wake a VM. */
export const PROVIDER_OPERATION_MS = 180_000;
/** Creates, snapshots and resizes copy or move a whole disk. */
const DISK_OPERATION_MS = 600_000;
/** The provider's own exec limit when a call names none (product-vm FREESTYLE_EXEC_TIMEOUT_MS_MAX). */
const EXEC_DEFAULT_MS = 300_000;
const EXEC_GRACE_MS = 90_000;

export const PROVIDER_TIMEOUT_CODE = "PROVIDER_TIMEOUT";
const PROVIDER_TIMEOUT_BODY = {
	code: PROVIDER_TIMEOUT_CODE,
	message: "The machine provider did not answer in time.",
};

/** This client's own timeout, shaped as the provider's 504 (a transient failure). */
export function providerTimeoutError(path: string) {
	return new FreestyleApiError(504, PROVIDER_TIMEOUT_BODY, path);
}

/** How long a backgrounded call may be polled before this client gives up on it. */
export function providerOperationBudgetMs(
	method: string,
	pathname: string,
	body: unknown,
) {
	if (method === "POST" && pathname.endsWith("/exec-await")) {
		let timeoutMs: unknown;
		try {
			timeoutMs = (JSON.parse(String(body)) as { timeoutMs?: unknown })
				.timeoutMs;
		} catch {}
		return (
			(typeof timeoutMs === "number" && timeoutMs > 0
				? timeoutMs
				: EXEC_DEFAULT_MS) + EXEC_GRACE_MS
		);
	}
	if (
		method === "POST" &&
		(pathname === "/v5/vms" || /\/(snapshot|resize)$/.test(pathname))
	)
		return DISK_OPERATION_MS;
	return PROVIDER_OPERATION_MS;
}

/**
 * Bounds every provider call on the client side. The SDK backgrounds a slow
 * request (202) and then polls it with no limit of its own; a guest that
 * never answers held a call for ~12 minutes until the provider gave up. Each
 * HTTP request gets a timeout, and a backgrounded call is polled only for
 * its operation's budget (an exec: its own timeout plus a grace), after which
 * the poll answers 504 PROVIDER_TIMEOUT, a transient failure. Install it
 * innermost, on the transport, so it sees the final background header.
 */
export function boundedFreestyleFetch(
	transport: typeof fetch = globalThis.fetch.bind(globalThis),
	now: () => number = Date.now,
): typeof fetch {
	/** Poll path -> when its call's budget ends. */
	const deadlines = new Map<string, number>();
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		const started = now();
		if (url.pathname.startsWith(POLL_PREFIX)) {
			let deadline = deadlines.get(url.pathname);
			if (deadline === undefined) {
				deadline = started + PROVIDER_OPERATION_MS;
				deadlines.set(url.pathname, deadline);
			}
			if (started >= deadline) {
				deadlines.delete(url.pathname);
				return new Response(JSON.stringify(PROVIDER_TIMEOUT_BODY), {
					status: 504,
					headers: { "content-type": "application/json" },
				});
			}
			const response = await timed(
				transport,
				input,
				init,
				Math.min(POLL_REQUEST_MS, deadline - started),
				url.pathname,
				true,
			);
			if (response.status !== 202) deadlines.delete(url.pathname);
			return response;
		}
		const after = Number(headers.get(BACKGROUND_AFTER_HEADER));
		const backgrounded = Number.isFinite(after) && after > 0;
		const bytes =
			!backgrounded ||
			headers.get("content-type") === "application/octet-stream";
		const response = await timed(
			transport,
			input,
			init,
			bytes ? TRANSFER_MS : after * 1000 + REQUEST_GRACE_MS,
			url.pathname,
			!bytes,
		);
		if (backgrounded && response.status === 202) {
			const id =
				response.headers.get(BACKGROUND_ID_HEADER) ??
				(
					(await response
						.clone()
						.json()
						.catch(() => ({}))) as { requestId?: string }
				).requestId;
			if (id) {
				for (const [path, deadline] of deadlines)
					if (deadline <= started) deadlines.delete(path);
				deadlines.set(
					`${POLL_PREFIX}${encodeURIComponent(id)}`,
					started + providerOperationBudgetMs(method, url.pathname, init?.body),
				);
			}
		}
		return response;
	};
}

/**
 * One HTTP request under a timeout. A JSON answer is read whole inside it, so
 * a stalled body cannot outlive it either; file bytes stream to the caller.
 * The caller's own abort keeps its reason; this timeout becomes a 504.
 */
async function timed(
	transport: typeof fetch,
	input: Parameters<typeof fetch>[0],
	init: RequestInit | undefined,
	ms: number,
	path: string,
	buffer: boolean,
) {
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), Math.max(1, ms));
	const signal = init?.signal
		? AbortSignal.any([init.signal, timeout.signal])
		: timeout.signal;
	try {
		const response = await transport(input, { ...init, signal });
		if (!buffer) return response;
		const body = await response.arrayBuffer();
		return new Response(body.byteLength ? body : null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (error) {
		if (timeout.signal.aborted && !init?.signal?.aborted)
			throw providerTimeoutError(path);
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Poll waits for a backgrounded call: quick at first, then every second for
 * its first half minute (a create from a snapshot the host has not cached
 * took 15 s on dev, and 2 s polls added up to 2 s to it), then the SDK's own
 * 2 s for long commands.
 */
export const FAST_POLL_DELAYS_MS: readonly number[] = [
	250,
	250,
	500,
	500,
	...Array<number>(27).fill(1_000),
];
const SLOW_POLL_MS = 2_000;

/**
 * Follows a backgrounded call (202) here, so the SDK sees its final answer.
 * The SDK polls every 2 s, which added up to 2 s to every wake, desktop start
 * and exec past 5 s; this polls sooner, then as often as the SDK did. Install
 * it outside boundedFreestyleFetch, which still ends a poll at its budget.
 */
export function fastPollFreestyleFetch(
	transport: typeof fetch,
	delays: readonly number[] = FAST_POLL_DELAYS_MS,
): typeof fetch {
	return async (input, init) => {
		const response = await transport(input, init);
		if (response.status !== 202) return response;
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.startsWith(POLL_PREFIX)) return response;
		const id =
			response.headers.get(BACKGROUND_ID_HEADER) ??
			(
				(await response
					.clone()
					.json()
					.catch(() => ({}))) as { requestId?: string }
			).requestId;
		if (!id) return response;
		const poll = new URL(`${POLL_PREFIX}${encodeURIComponent(id)}`, url);
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
		);
		headers.delete(BACKGROUND_AFTER_HEADER);
		headers.delete("content-type");
		for (let attempt = 0; ; attempt++) {
			await sleep(delays[attempt] ?? SLOW_POLL_MS, init?.signal);
			const next = await transport(poll, {
				method: "GET",
				headers,
				signal: init?.signal,
			});
			if (next.status !== 202) return next;
		}
	};
}

function sleep(ms: number, signal?: AbortSignal | null) {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", stop);
			resolve();
		}, ms);
		function stop() {
			clearTimeout(timer);
			reject(signal?.reason);
		}
		signal?.addEventListener("abort", stop, { once: true });
	});
}
