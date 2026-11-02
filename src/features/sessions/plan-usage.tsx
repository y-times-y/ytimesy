import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { claudePlanUsageBars } from "#/domain/claude-plan-usage";
import {
	type PlanLimitReached,
	type PlanUsageBar,
	planLimitSwitches,
	planUsageBars,
	withPlanLimitReached,
} from "#/domain/plan-usage-bars";
import type { SessionItem } from "#/domain/session-item";
import { usageResetLabel } from "#/domain/usage-warning";
import {
	claudePlanUsageFn,
	codexSubscriptionUsageFn,
} from "../workspace/subscription-usage.fn";
import { PickerUsageLine } from "../workspace/usage-windows";

/** Shared with Settings' ChatGPT subscription limits. */
const PLAN_USAGE_KEY = ["codex-subscription-usage"] as const;
const PLAN_USAGE_STALE_MS = 30_000;
const PLAN_LOW_PERCENT = 85;

let planLimit: PlanLimitReached | null = null;
const planLimitListeners = new Set<() => void>();

function setPlanLimit(limit: PlanLimitReached) {
	planLimit = limit;
	for (const listener of planLimitListeners) listener();
}

function usePlanLimit() {
	return useSyncExternalStore(
		(listener) => {
			planLimitListeners.add(listener);
			return () => planLimitListeners.delete(listener);
		},
		() => planLimit,
		() => null,
	);
}

function usePlanUsageQueryFn() {
	const readUsage = useServerFn(codexSubscriptionUsageFn);
	return () => readUsage();
}

/** Starts the plan usage read before the picker opens (hover or focus on its trigger). */
export function usePrefetchPlanUsage() {
	const queryClient = useQueryClient();
	const queryFn = usePlanUsageQueryFn();
	return () =>
		void queryClient.prefetchQuery({
			queryKey: PLAN_USAGE_KEY,
			queryFn,
			staleTime: PLAN_USAGE_STALE_MS,
			retry: false,
		});
}

/**
 * The ChatGPT plan's windows while the picker is open. Empty when the user
 * has no plan signed in or its usage cannot be read, unless a turn just hit
 * the plan's limit.
 */
export function usePlanUsageBars(open: boolean): PlanUsageBar[] {
	const queryFn = usePlanUsageQueryFn();
	const usage = useQuery({
		queryKey: PLAN_USAGE_KEY,
		queryFn,
		enabled: open,
		staleTime: PLAN_USAGE_STALE_MS,
		retry: false,
	});
	const limit = usePlanLimit();
	if (!open) return [];
	return withPlanLimitReached(planUsageBars(usage.data), limit, Date.now());
}

/**
 * A transcript's usage-limit failovers mark the plan as spent at once and
 * re-read its usage. On first sight of a transcript only limits that have not
 * reset yet count; ones with no reset time count only when they arrive live.
 */
export function useMarkPlanLimitFromSwitches(items: readonly SessionItem[]) {
	const queryClient = useQueryClient();
	const seen = useRef<Set<string> | null>(null);
	useEffect(() => {
		const switches = planLimitSwitches(items);
		const now = Date.now();
		const first = seen.current === null;
		const known = seen.current ?? new Set<string>();
		seen.current = known;
		const fresh = switches.filter(
			(row) =>
				!known.has(row.id) &&
				(!first || (row.resetsAt !== null && row.resetsAt > now)),
		);
		for (const row of switches) known.add(row.id);
		const latest = fresh.at(-1);
		if (!latest) return;
		setPlanLimit({ resetsAt: latest.resetsAt, at: now });
		void queryClient.invalidateQueries({ queryKey: PLAN_USAGE_KEY });
	}, [items, queryClient]);
}

const CLAUDE_PLAN_USAGE_KEY = ["claude-plan-usage"] as const;

/**
 * The Claude plan's windows while the picker is open, from the last reading
 * the edge took off Anthropic's responses. Empty while Claude is not
 * connected or has not been used yet.
 */
export function useClaudePlanUsageBars(
	open: boolean,
	connected: boolean,
): PlanUsageBar[] {
	const readUsage = useServerFn(claudePlanUsageFn);
	const usage = useQuery({
		queryKey: CLAUDE_PLAN_USAGE_KEY,
		queryFn: () => readUsage(),
		enabled: open && connected,
		staleTime: PLAN_USAGE_STALE_MS,
		retry: false,
	});
	if (!open || !connected) return [];
	return claudePlanUsageBars(usage.data, Date.now());
}

export const CLAUDE_PLAN_USAGE_HINT = "Updates after Claude is used";

/** A subscription plan's line in the model picker (ChatGPT by default). */
export function ModelPickerPlanUsage({
	bars,
	label = "ChatGPT plan",
	hint,
}: {
	bars: readonly PlanUsageBar[];
	label?: string;
	hint?: string;
}) {
	return (
		<PickerUsageLine
			label={label}
			hint={hint}
			bars={bars.map((bar) => ({
				id: bar.id,
				label: bar.label,
				usedPercent: bar.usedPercent,
				low: bar.usedPercent >= PLAN_LOW_PERCENT,
				detail: bar.resetsAt
					? `Resets ${usageResetLabel(bar.resetsAt)}`
					: undefined,
			}))}
		/>
	);
}
