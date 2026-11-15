import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

export const WORKSPACE_METADATA_PURPOSE = "ytimesy-workspace";
export const FREESTYLE_EXEC_TIMEOUT_MS_MAX = 300_000;

/**
 * Pause after this long with no traffic (an exec, including one still
 * running, public or terminal traffic). A paused VM's next exec resumes it
 * in under a second, so the VM no longer runs (and bills) through a model's
 * long thinking between tool calls, nor three minutes after every turn.
 * Measured 2026-11-14: exec calls and an exec in flight hold it awake; a
 * detached process alone does not (it freezes until the next traffic).
 */
export const PRODUCT_IDLE_TIMEOUT_SECONDS = 60;
/**
 * A VM that started a background command (a build, a dev server) keeps the
 * longer timeout, so the command is not frozen between the watcher's looks
 * (every two minutes while a turn runs).
 */
export const BACKGROUND_IDLE_TIMEOUT_SECONDS = 180;

/**
 * Delete a product VM after this long without running. Freestyle resets the
 * clock on every start, so this is "30 days unused", not an age limit. It
 * replaces workspace recycling as the cap on idle storage: a paused VM keeps
 * memory and disk, resumes in place, and bills the same storage a snapshot
 * would (docs/workspace-retention.md, decision 2026-11-11).
 */
export const PRODUCT_AUTO_DELETE_SECONDS = 30 * 24 * 60 * 60;

/** Smallest real Ubuntu image. Copies from a 4 vCPU snapshot stay 4 vCPU; resize cannot shrink. */
export const CHEAP_BASE_SNAPSHOT = "freestyle/ubuntu-sm";
/** What CHEAP_BASE_SNAPSHOT boots with (vCPU, MiB, MiB). */
export const CHEAP_BASE_RESOURCES = {
	cpu: 2,
	memory: 4096,
	storage: 16384,
} as const;

export function productIdleTimeoutNeedsUpdate(
	current: number | null | undefined,
) {
	return (
		current !== PRODUCT_IDLE_TIMEOUT_SECONDS &&
		current !== BACKGROUND_IDLE_TIMEOUT_SECONDS
	);
}

/**
 * The lifecycle settings a product VM made before them (or changed since)
 * still needs, or undefined when it has them. Applied on resume, the moment
 * the VM runs, so the auto-delete window never lands on a long-idle VM.
 */
export function productLifecycleUpdate(data: {
	readonly idleTimeoutSeconds?: number | null;
	readonly autoDeleteSeconds?: number | null;
}) {
	const update: {
		idleTimeoutSeconds?: number;
		autoDeleteSeconds?: number;
	} = {};
	if (productIdleTimeoutNeedsUpdate(data.idleTimeoutSeconds))
		update.idleTimeoutSeconds = PRODUCT_IDLE_TIMEOUT_SECONDS;
	if (data.autoDeleteSeconds !== PRODUCT_AUTO_DELETE_SECONDS)
		update.autoDeleteSeconds = PRODUCT_AUTO_DELETE_SECONDS;
	return Object.keys(update).length ? update : undefined;
}

export function productCreateVmFields(input: {
	readonly slug: string;
	readonly snapshotId?: string;
}) {
	return {
		slug: input.slug,
		displayName: "ytimesy workspace",
		firewall: GUEST_INTERNET_FIREWALL,
		metadata: { purpose: WORKSPACE_METADATA_PURPOSE },
		idleTimeoutSeconds: PRODUCT_IDLE_TIMEOUT_SECONDS,
		autoDeleteSeconds: PRODUCT_AUTO_DELETE_SECONDS,
		snapshotId: input.snapshotId ?? CHEAP_BASE_SNAPSHOT,
	};
}

export function freestyleExecTimeoutMs(requestedMs: number) {
	return Math.min(Math.max(1, requestedMs), FREESTYLE_EXEC_TIMEOUT_MS_MAX);
}
