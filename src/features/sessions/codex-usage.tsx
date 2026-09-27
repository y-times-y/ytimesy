import type { CodexUsage } from "#/domain/codex-usage";

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
			className="settings-card codex-subscription-usage"
			aria-label="Codex subscription usage"
		>
			<strong>Codex subscription · shared across your account</strong>
			{limits.length ? (
				limits.map(([id, bucket]) => (
					<div key={id}>
						{limits.length > 1 ? <p>{bucket.limitName ?? id}</p> : null}
						{[bucket.primary, bucket.secondary].map((window, index) =>
							window ? (
								<div key={index === 0 ? "primary" : "secondary"}>
									<span>
										{window.windowDurationMins
											? `${window.windowDurationMins / 60}h window`
											: "Usage window"}{" "}
										· {window.usedPercent}% used
									</span>
									<meter
										min={0}
										max={100}
										value={window.usedPercent}
										aria-label="Subscription usage"
									/>
									{window.resetsAt ? (
										<small>
											Resets {new Date(window.resetsAt * 1000).toLocaleString()}
										</small>
									) : null}
								</div>
							) : null,
						)}
					</div>
				))
			) : (
				<p>Subscription usage unavailable.</p>
			)}
			{usage?.updatedAt ? (
				<small>
					Last updated {new Date(usage.updatedAt * 1000).toLocaleTimeString()}
				</small>
			) : null}
		</section>
	);
}
