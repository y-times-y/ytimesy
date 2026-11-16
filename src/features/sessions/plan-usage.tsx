import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { claudePlanUsageBars } from "#/domain/claude-plan-usage";
import { grokPlanUsageBars } from "#/domain/grok-plan-usage";
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
	grokPlanUsageFn,
} from "../workspace/subscription-usage.fn";
import { PickerUsageLine } from "../workspace/usage-windows";

/** Shared with Settings' ChatGPT subscription limits. */
const PLAN_USAGE_KEY = ["codex-subscription-usage"] as const;
const CLAUDE_PLAN_USAGE_KEY = ["claude-plan-usage"] as const;
const GROK_PLAN_USAGE_KEY = ["grok-plan-usage"] as const;
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

/**
 * Starts the plan usage reads before the picker opens (hover or focus on its
 * trigger), so each section's line is there when it opens.
 */
export function usePrefetchPlanUsage(
	claudeConnected = false,
	grokConnected = false,
) {
	const queryClient = useQueryClient();
	const queryFn = usePlanUsageQueryFn();
	const readClaude = useServerFn(claudePlanUsageFn);
	const readGrok = useServerFn(grokPlanUsageFn);
	return () => {
		void queryClient.prefetchQuery({
			queryKey: PLAN_USAGE_KEY,
			queryFn,
			staleTime: PLAN_USAGE_STALE_MS,
			retry: false,
		});
		if (claudeConnected)
			void queryClient.prefetchQuery({
				queryKey: CLAUDE_PLAN_USAGE_KEY,
				queryFn: () => readClaude(),
				staleTime: PLAN_USAGE_STALE_MS,
				retry: false,
			});
		if (grokConnected)
			void queryClient.prefetchQuery({
				queryKey: GROK_PLAN_USAGE_KEY,
				queryFn: () => readGrok(),
				staleTime: PLAN_USAGE_STALE_MS,
				retry: false,
			});
	};
}

/**
 * The ChatGPT plan's windows while the picker is open. Empty when the user
 * has no plan signed in or its usage cannot be read, unless a turn just hit
 * the plan's limit.
 */
export function usePlanUsageBars(open: boolean): PlanUsageBar[] {
	return usePlanUsageLine(open).bars;
}

/** A plan's bars, and whether its first reading is still on the way. */
export type PlanUsageLine = {
	readonly bars: PlanUsageBar[];
	readonly pending: boolean;
};

/** The ChatGPT plan's line for the picker's Codex section. */
export function usePlanUsageLine(open: boolean): PlanUsageLine {
	const queryFn = usePlanUsageQueryFn();
	const usage = useQuery({
		queryKey: PLAN_USAGE_KEY,
		queryFn,
		enabled: open,
		staleTime: PLAN_USAGE_STALE_MS,
		retry: false,
	});
	const limit = usePlanLimit();
	if (!open) return { bars: [], pending: false };
	return {
		bars: withPlanLimitReached(planUsageBars(usage.data), limit, Date.now()),
		pending: usage.isPending && usage.fetchStatus === "fetching",
	};
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

/**
 * The Claude plan's line while the picker is open: the edge's last reading,
 * which the server reads afresh when it is over five minutes old. Empty
 * while Claude is not connected or its usage cannot be read.
 */
export function useClaudePlanUsageLine(
	open: boolean,
	connected: boolean,
): PlanUsageLine {
	const readUsage = useServerFn(claudePlanUsageFn);
	const usage = useQuery({
		queryKey: CLAUDE_PLAN_USAGE_KEY,
		queryFn: () => readUsage(),
		enabled: open && connected,
		staleTime: PLAN_USAGE_STALE_MS,
		retry: false,
	});
	if (!open || !connected) return { bars: [], pending: false };
	return {
		bars: claudePlanUsageBars(usage.data, Date.now()),
		pending: usage.isPending && usage.fetchStatus === "fetching",
	};
}

/**
 * The Grok plan's line while the picker (or Settings) is open: the last
 * reading, which the server reads afresh when it is over five minutes old.
 * Empty while the plan is not connected or its usage cannot be read.
 */
export function useGrokPlanUsageLine(
	open: boolean,
	connected: boolean,
): PlanUsageLine {
	const readUsage = useServerFn(grokPlanUsageFn);
	const usage = useQuery({
		queryKey: GROK_PLAN_USAGE_KEY,
		queryFn: () => readUsage(),
		enabled: open && connected,
		staleTime: PLAN_USAGE_STALE_MS,
		retry: false,
	});
	if (!open || !connected) return { bars: [], pending: false };
	return {
		bars: grokPlanUsageBars(usage.data, Date.now()),
		pending: usage.isPending && usage.fetchStatus === "fetching",
	};
}

export const CLAUDE_PLAN_USAGE_HINT = "Reading it uses a tiny bit of your plan";

/**
 * A plan's line inside its own section of the picker. While the first
 * reading is on the way it keeps the line's height, so nothing jumps.
 */
export function SectionPlanUsage({
	line,
	label,
	hint,
}: {
	line: PlanUsageLine;
	label: string;
	hint?: string;
}) {
	// Sits at the end of the section's heading row, so it never moves the list.
	if (!line.bars.length) return null;
	return (
		<span
			className="section-plan-usage"
			aria-label={`${label} usage`}
			title={hint}
		>
			{line.bars.map((bar) => {
				const used = Math.min(100, Math.max(0, bar.usedPercent));
				const left = 100 - used;
				return (
					<span
						key={bar.id}
						data-low={used >= PLAN_LOW_PERCENT || undefined}
						title={
							bar.resetsAt
								? `${left}% left · Resets ${usageResetLabel(bar.resetsAt)}`
								: `${left}% left`
						}
					>
						{`${bar.label} ${left}% left`}
					</span>
				);
			})}
		</span>
	);
}

/** A subscription plan's line in the model picker (ChatGPT by default). */
export function ModelPickerPlanUsage({
	bars,
	label = "ChatGPT plan",
	hint,
	className,
}: {
	bars: readonly PlanUsageBar[];
	label?: string;
	hint?: string;
	className?: string;
}) {
	return (
		<PickerUsageLine
			label={label}
			hint={hint}
			className={className}
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
