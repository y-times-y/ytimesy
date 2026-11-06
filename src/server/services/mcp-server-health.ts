/**
 * What this isolate remembers about MCP servers that failed to connect, so a
 * server that stays down is logged once per change of state (and once an hour
 * while it stays down) and is not retried on every step of every turn.
 */
const REPEAT_LOG_MS = 60 * 60_000;
const FIRST_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 2 * 60_000;
const MAX_TRACKED = 500;

type Down = {
	reason: string;
	failures: number;
	loggedAt: number;
	retryAt: number;
};

const down = new Map<string, Down>();

export function mcpServerKey(server: { name: string; url: string }) {
	return `${server.name}\n${server.url}`;
}

/** True while a recently failed server should not be connected again yet. */
export function mcpServerInBackoff(key: string, now = Date.now()) {
	const state = down.get(key);
	return Boolean(state && now < state.retryAt);
}

/** Records a failed connection; returns whether it should be logged now. */
export function noteMcpServerFailure(
	key: string,
	reason: string,
	now = Date.now(),
) {
	const previous = down.get(key);
	const failures = (previous?.failures ?? 0) + 1;
	const backoff = Math.min(
		MAX_BACKOFF_MS,
		FIRST_BACKOFF_MS * 2 ** (failures - 1),
	);
	const shouldLog =
		!previous ||
		previous.reason !== reason ||
		now - previous.loggedAt >= REPEAT_LOG_MS;
	if (!previous && down.size >= MAX_TRACKED) {
		const oldest = down.keys().next().value;
		if (oldest !== undefined) down.delete(oldest);
	}
	down.set(key, {
		reason,
		failures,
		loggedAt: shouldLog ? now : (previous?.loggedAt ?? now),
		retryAt: now + backoff,
	});
	return shouldLog;
}

/** Records a working connection; returns whether the server had been down. */
export function noteMcpServerRecovered(key: string) {
	return down.delete(key);
}

export function resetMcpServerHealthForTests() {
	down.clear();
}
