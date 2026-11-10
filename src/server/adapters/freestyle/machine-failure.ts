import { FreestyleApiError } from "freestyle";
import { redactSecrets } from "#/domain/redact-secrets";
import { isTransientProviderFailure } from "./provider-retry";

/**
 * What a failed machine operation means for a retry:
 * - transient: a provider 5xx/timeout or a connection that never answered;
 * - rate-limited: the provider's 429;
 * - conflict: a slug-keyed create met a VM an earlier (possibly interrupted,
 *   possibly still running) attempt is making;
 * - busy: our own per-VM usage lease is held, e.g. by an attempt a Durable
 *   Object restart killed (the lease outlives it by up to 90 s);
 * - stuck: the provider never reported the VM running (or it stopped while
 *   starting); a fresh start request may succeed, so it is repeated once;
 * - not-found: the VM or snapshot is gone;
 * - quota: the account's VM or compute allowance;
 * - permanent: anything else (a refusal, a bad request, our own config).
 */
export type MachineFailureKind =
	| "transient"
	| "rate-limited"
	| "conflict"
	| "busy"
	| "stuck"
	| "not-found"
	| "quota"
	| "permanent";

const NOT_RUNNING_IN_TIME =
	/did not become running|stopped before it became running/i;
const LEASE_BUSY = /another operation is updating this machine/i;
const QUOTA =
	/LIMIT_EXCEEDED|limit of \d+ VMs|at its VM limit|allowance for vcpu_time|memory_time has been used|compute allowance/i;

function chain(error: unknown): unknown[] {
	const seen: unknown[] = [];
	let current = error;
	while (current && seen.length < 6 && !seen.includes(current)) {
		seen.push(current);
		const record = current as {
			providerError?: unknown;
			cause?: unknown;
			error?: unknown;
			lastError?: unknown;
		};
		current =
			record.providerError ?? record.lastError ?? record.cause ?? record.error;
	}
	return seen;
}

export function machineFailureKind(error: unknown): MachineFailureKind {
	const links = chain(error);
	for (const link of links)
		if (link instanceof FreestyleApiError) {
			if (link.status === 429) return "rate-limited";
			if (
				link.status === 409 &&
				/already in use|already exists/i.test(link.message)
			)
				return "conflict";
			if (link.status === 404 || link.code === "NOT_FOUND") return "not-found";
		}
	const text = links
		.map((link) => (link instanceof Error ? link.message : ""))
		.join(" ");
	if (QUOTA.test(text)) return "quota";
	if (LEASE_BUSY.test(text)) return "busy";
	if (NOT_RUNNING_IN_TIME.test(text)) return "stuck";
	if (isTransientProviderFailure(error)) return "transient";
	return "permanent";
}

/** Kinds a machine start waits out and repeats rather than surface. */
export function machineFailureRetryable(kind: MachineFailureKind) {
	return (
		kind === "transient" ||
		kind === "rate-limited" ||
		kind === "conflict" ||
		kind === "busy" ||
		kind === "stuck"
	);
}

/** Freestyle's x-request-id of recent failed responses, by method and path (bounded). */
const failedRequestIds = new Map<string, string>();
const FAILED_REQUEST_IDS_KEPT = 200;

function requestKey(path: string) {
	return path.split("?")[0] ?? path;
}

/**
 * Wraps the provider transport so a failed response's x-request-id can be
 * named in the failure log (the SDK's error does not carry it).
 */
export function requestIdRecordingFetch(transport: typeof fetch): typeof fetch {
	return async (request, init) => {
		const response = await transport(request, init);
		if (!response.ok && response.status !== 202) {
			const id = response.headers.get("x-request-id");
			if (id) {
				const url = new URL(
					request instanceof Request ? request.url : String(request),
				);
				failedRequestIds.delete(requestKey(url.pathname));
				failedRequestIds.set(requestKey(url.pathname), id);
				if (failedRequestIds.size > FAILED_REQUEST_IDS_KEPT) {
					const oldest = failedRequestIds.keys().next().value;
					if (oldest !== undefined) failedRequestIds.delete(oldest);
				}
			}
		}
		return response;
	};
}

/**
 * The raw failure, every link of its chain, for the owner's logs and the
 * turn's stored cause: names, provider status/code/path and messages, with
 * tokens and credentials removed. Never shown as the user's message.
 */
export function machineFailureDetail(error: unknown): string {
	const parts = chain(error).map((link) => {
		if (link instanceof FreestyleApiError)
			return `FreestyleApiError ${link.status} ${link.code}${link.path ? ` ${link.path}` : ""}: ${link.message}`;
		if (link instanceof Error) {
			const tag = (link as { _tag?: unknown })._tag;
			return `${typeof tag === "string" ? tag : link.name}: ${link.message}`;
		}
		return typeof link === "string" ? link : (JSON.stringify(link) ?? "");
	});
	return redactSecrets(
		parts.filter((part, index) => parts.indexOf(part) === index).join(" <- "),
		600,
	);
}

function freestyleRequestId(error: unknown) {
	for (const link of chain(error))
		if (link instanceof FreestyleApiError && link.path)
			return failedRequestIds.get(requestKey(link.path));
	return undefined;
}

/**
 * Logs one failed machine operation with what the owner needs to know why:
 * the operation, slug and VM, the failure kind, the provider's request id and
 * the raw (redacted) error. Called on every attempt, retried or not.
 */
export function logMachineFailure(input: {
	readonly operation: string;
	readonly error: unknown;
	readonly slug?: string;
	readonly vmId?: string;
	readonly attempt?: number;
	readonly willRetry?: boolean;
}) {
	console.warn("Machine operation failed", {
		operation: input.operation,
		slug: input.slug,
		vmId: input.vmId,
		attempt: input.attempt,
		willRetry: input.willRetry ?? false,
		kind: machineFailureKind(input.error),
		freestyleRequestId: freestyleRequestId(input.error),
		detail: machineFailureDetail(input.error),
	});
}

const MAX_STUCK_REPEATS = 1;

/**
 * Backoff for a machine start that met a passing condition: about 90 s in
 * all, which outlasts the usage lease (90 s) an attempt killed by a Durable
 * Object restart leaves behind.
 */
export const MACHINE_START_RETRY_DELAYS_MS = [
	1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000,
] as const;

/**
 * Runs a start the caller made safe to repeat (slug-keyed: a repeat finds and
 * resumes what an earlier, possibly interrupted, attempt made) until it
 * succeeds, waiting out transient provider errors, rate limits, a slug
 * another attempt is still creating and a held usage lease. A permanent
 * failure, or one that outlasts the backoff, propagates. Every failed
 * attempt is logged with its raw (redacted) cause.
 */
export async function resumableMachineStart<T>(
	operation: () => Promise<T>,
	context: {
		readonly operation: string;
		readonly slug?: string;
		readonly vmId?: string;
	},
	delaysMs: readonly number[] = MACHINE_START_RETRY_DELAYS_MS,
	wait: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
	let stuckRepeats = 0;
	for (let attempt = 0; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const kind = machineFailureKind(error);
			// A machine that stayed stuck gets one more start, not the full
			// backoff: each try already waited about a minute.
			const stuckExhausted =
				kind === "stuck" && stuckRepeats >= MAX_STUCK_REPEATS;
			const willRetry =
				attempt < delaysMs.length &&
				machineFailureRetryable(kind) &&
				!stuckExhausted;
			if (kind === "stuck" && willRetry) stuckRepeats++;
			logMachineFailure({ ...context, error, attempt: attempt + 1, willRetry });
			if (!willRetry) throw error;
			await wait(delaysMs[attempt] ?? 0);
		}
	}
}
