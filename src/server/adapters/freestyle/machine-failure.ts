import { FreestyleApiError } from "freestyle";
import { refusalIsNotAboutTheMachine } from "#/domain/machine-replacement";
import { redactSecrets } from "#/domain/redact-secrets";
import {
	isTransientProviderFailure,
	PROVIDER_UNAVAILABLE_MESSAGE,
} from "./provider-retry";

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
/**
 * The VM's own host cannot run it: its guest never answers a command, or the
 * host is full ("server is at capacity", a 429 for that VM). A new VM lands
 * on another host, so these count toward replacing it.
 */
const HOST_CANNOT_RUN_VM =
	/started but is not answering|server is at capacity/i;
const LEASE_BUSY = /another operation is updating this machine/i;
const QUOTA =
	/LIMIT_EXCEEDED|limit of \d+ VMs|at its VM limit|allowance for vcpu_time|memory_time has been used|compute allowance|workspace storage is nearly full/i;

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

const BUDGET_SPENT =
	/total runtime budget|maxRunTotalSeconds|runtime budget is (?:spent|used up)/i;

/**
 * The VM has used its whole runtime budget, so every start of it is refused.
 * The refusal is certain and permanent for that VM (a new one has a fresh
 * budget), so it is replaced at once rather than after a failure streak.
 */
export function machineBudgetSpent(error: unknown): boolean {
	return chain(error).some((link) => {
		const detail =
			link && typeof link === "object"
				? String((link as { detail?: unknown }).detail ?? "")
				: "";
		return BUDGET_SPENT.test(
			`${link instanceof Error ? link.message : ""} ${detail}`,
		);
	});
}

/**
 * Evidence, read from the VM's own data after a start that never ran, that
 * its runtime cap is used up (the provider then accepts the start and never
 * reports it running, so the error alone says only "did not become running").
 * Returns text machineBudgetSpent recognises, or undefined.
 */
export function spentBudgetEvidence(data: {
	readonly state?: string | null;
	readonly totalRunSeconds?: number | null;
	readonly maxRunTotalSeconds?: number | null;
}): string | undefined {
	if (data.totalRunSeconds == null || data.maxRunTotalSeconds == null) return;
	if (data.state === "running") return;
	return data.totalRunSeconds >= data.maxRunTotalSeconds
		? `runtime budget is spent (${Math.floor(data.totalRunSeconds)} of ${data.maxRunTotalSeconds} s)`
		: undefined;
}

/**
 * A failed start of an existing VM that is the VM's own (the provider never
 * brought it up: a 5xx/timeout, "did not become running"), not our account's
 * (capacity, usage allowance, quota, auth) and not a gone VM. Works on the
 * wrapped WorkspaceProvisionError too: its message is the public one, its
 * `detail` carries the raw provider failure.
 */
export function machineStartUnstartable(error: unknown): boolean {
	const detail =
		error && typeof error === "object"
			? String((error as { detail?: unknown }).detail ?? "")
			: "";
	const text = `${error instanceof Error ? error.message : ""} ${detail}`;
	if (refusalIsNotAboutTheMachine(text) || QUOTA.test(text)) return false;
	const kind = machineFailureKind(error);
	if (kind === "stuck" || kind === "transient") return true;
	return (
		text.includes(PROVIDER_UNAVAILABLE_MESSAGE) ||
		NOT_RUNNING_IN_TIME.test(text) ||
		// 2026-11-16: a chat stuck on "isn't responding" for hours, its VM's
		// host full, because neither failure counted and it was never replaced.
		HOST_CANNOT_RUN_VM.test(text) ||
		/FreestyleApiError 5\d\d|PROVIDER_TIMEOUT/.test(detail)
	);
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
/** Retry-After (ms) the provider sent with its latest 429, by path. */
const retryAfterMs = new Map<string, number>();

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
			const retryAfter = Number(response.headers.get("retry-after"));
			if (
				response.status === 429 &&
				Number.isFinite(retryAfter) &&
				retryAfter > 0
			) {
				const url = new URL(
					request instanceof Request ? request.url : String(request),
				);
				if (retryAfterMs.size > FAILED_REQUEST_IDS_KEPT) retryAfterMs.clear();
				retryAfterMs.set(requestKey(url.pathname), retryAfter * 1000);
			}
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
const RATE_LIMIT_DELAY_CAP_MS = 60_000;

/**
 * How long to wait after a provider limit: the backoff step with up to 50%
 * jitter (several chats hitting the limit together must not retry in step),
 * or the provider's Retry-After when it sent a longer one, capped at a minute.
 */
export function rateLimitDelayMs(
	baseMs: number,
	retryAfter: number | undefined,
	random: () => number = Math.random,
): number {
	const jittered = baseMs * (1 + random() * 0.5);
	return Math.min(Math.max(jittered, retryAfter ?? 0), RATE_LIMIT_DELAY_CAP_MS);
}

export type MachineRateLimitHit = {
	readonly operation: string;
	readonly slug?: string;
	readonly attempt: number;
	readonly status?: number;
	readonly retryAfterMs?: number;
};

function rateLimitedRetryAfter(error: unknown): number | undefined {
	for (const link of chain(error))
		if (link instanceof FreestyleApiError && link.path)
			return retryAfterMs.get(requestKey(link.path));
	return undefined;
}

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
	onRateLimited?: (hit: MachineRateLimitHit) => void,
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
			let delay = delaysMs[attempt] ?? 0;
			if (kind === "rate-limited") {
				const retryAfter = rateLimitedRetryAfter(error);
				// One email-free line and one monitoring row per hit, whether or
				// not the user ever sees anything.
				console.warn("machine.rate_limited", {
					operation: context.operation,
					slug: context.slug,
					attempt: attempt + 1,
					retryAfterMs: retryAfter,
					willRetry,
					detail: machineFailureDetail(error),
				});
				try {
					onRateLimited?.({
						operation: context.operation,
						slug: context.slug,
						attempt: attempt + 1,
						retryAfterMs: retryAfter,
					});
				} catch {
					// Bookkeeping never blocks the start.
				}
				delay = rateLimitDelayMs(delay, retryAfter);
			}
			if (!willRetry) throw error;
			await wait(delay);
		}
	}
}
