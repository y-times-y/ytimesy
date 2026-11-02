import type { PlanUsageBar } from "#/domain/plan-usage-bars";
import { usageResetLabel } from "#/domain/usage-warning";
import {
	CLAUDE_PLAN_USAGE_HINT,
	useClaudePlanUsageLine,
	useGrokPlanUsageLine,
	usePlanUsageBars,
} from "./plan-usage";

const LOW_PERCENT = 85;

/** One plan's windows in Settings, each with its reset time. */
function PlanUsageCard({
	title,
	label,
	bars,
	pending = false,
	hint,
}: {
	title: string;
	label: string;
	bars: readonly PlanUsageBar[];
	pending?: boolean;
	hint?: string;
}) {
	return (
		<section
			className="settings-group settings-group-body codex-subscription-usage"
			aria-label={label}
		>
			<p className="settings-row-title" title={hint}>
				{title}
			</p>
			{bars.length ? (
				bars.map((bar) => {
					const used = Math.min(100, Math.max(0, bar.usedPercent));
					return (
						<div key={bar.id} className="codex-usage-window">
							<div className="codex-usage-line">
								<span>{bar.label}</span>
								<strong data-low={used >= LOW_PERCENT || undefined}>
									{used >= 100 ? "Used up" : `${used}% used`}
								</strong>
							</div>
							{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
							<div
								className="codex-usage-meter"
								data-low={used >= LOW_PERCENT || undefined}
								role="meter"
								aria-label={`${bar.label} used`}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={used}
							>
								<span style={{ width: `${used}%` }} />
							</div>
							<p className="codex-usage-reset">
								{bar.resetsAt
									? `Resets ${usageResetLabel(bar.resetsAt)}`
									: "Reset time unknown"}
							</p>
						</div>
					);
				})
			) : (
				<p className="settings-row-meta">
					{pending ? "Reading usage…" : "Plan usage unavailable right now."}
				</p>
			)}
		</section>
	);
}

/**
 * Settings' ChatGPT plan usage: the same windows the model picker shows
 * (including a limit a turn just hit), each with its reset time.
 */
export function CodexSubscriptionUsage() {
	return (
		<PlanUsageCard
			title="ChatGPT plan usage"
			label="ChatGPT plan usage"
			bars={usePlanUsageBars(true)}
		/>
	);
}

/** Settings' Claude plan usage: the picker's reading, read afresh past five minutes. */
export function ClaudeSubscriptionUsage() {
	const line = useClaudePlanUsageLine(true, true);
	return (
		<PlanUsageCard
			title="Claude plan usage"
			label="Claude plan usage"
			bars={line.bars}
			pending={line.pending}
			hint={CLAUDE_PLAN_USAGE_HINT}
		/>
	);
}

/** Settings' Grok plan usage: the picker's reading, read afresh past five minutes. */
export function GrokSubscriptionUsage() {
	const line = useGrokPlanUsageLine(true, true);
	return (
		<PlanUsageCard
			title="Grok plan usage"
			label="Grok plan usage"
			bars={line.bars}
			pending={line.pending}
		/>
	);
}
