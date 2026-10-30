import { usageResetLabel } from "#/domain/usage-warning";
import { usePlanUsageBars } from "./plan-usage";

const LOW_PERCENT = 85;

/**
 * Settings' ChatGPT plan usage: the same windows the model picker shows
 * (including a limit a turn just hit), each with its reset time.
 */
export function CodexSubscriptionUsage() {
	const bars = usePlanUsageBars(true);
	return (
		<section
			className="settings-group settings-group-body codex-subscription-usage"
			aria-label="ChatGPT plan usage"
		>
			<p className="settings-row-title">ChatGPT plan usage</p>
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
				<p className="settings-row-meta">Plan usage unavailable right now.</p>
			)}
		</section>
	);
}
