import type { CodexUsage } from "#/domain/codex-usage";

function windowLabel(minutes?: number | null) {
	if (!minutes) return "Usage window";
	if (minutes % (60 * 24 * 7) === 0) return "Weekly limit";
	if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
	return `${minutes}-minute limit`;
}

function resetLabel(resetsAt?: number | null) {
	if (!resetsAt) return null;
	return `Resets ${new Date(resetsAt * 1000).toLocaleString(undefined, {
		weekday: "short",
		hour: "numeric",
		minute: "2-digit",
	})}`;
}

export function CodexSubscriptionUsage({ usage }: { usage?: CodexUsage }) {
	const buckets = usage?.limits?.rateLimitsByLimitId;
	const limits =
		buckets && Object.keys(buckets).length
			? Object.entries(buckets)
			: usage?.limits?.rateLimits
				? [["codex", usage.limits.rateLimits] as const]
				: [];
	return (
		<section
			className="settings-group settings-group-body codex-subscription-usage"
			aria-label="Codex subscription usage"
		>
			<p className="settings-row-title">ChatGPT subscription limits</p>
			{limits.length ? (
				limits.map(([id, bucket]) => (
					<div key={id}>
						{limits.length > 1 ? (
							<p className="settings-row-meta">{bucket.limitName ?? id}</p>
						) : null}
						{[bucket.primary, bucket.secondary].map((window, index) =>
							window ? (
								<div
									key={index === 0 ? "primary" : "secondary"}
									className="codex-usage-window"
								>
									<div className="codex-usage-line">
										<span>{windowLabel(window.windowDurationMins)}</span>
										<span>{window.usedPercent}% used</span>
									</div>
									{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
									<div
										className="settings-meter"
										data-tone={window.usedPercent >= 85 ? "low" : undefined}
										role="meter"
										aria-label="Subscription usage"
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={window.usedPercent}
									>
										<span style={{ width: `${window.usedPercent}%` }} />
									</div>
									{window.resetsAt ? (
										<p className="settings-row-meta">
											{resetLabel(window.resetsAt)}
										</p>
									) : null}
								</div>
							) : null,
						)}
					</div>
				))
			) : (
				<p className="settings-row-meta">Subscription usage unavailable.</p>
			)}
		</section>
	);
}
