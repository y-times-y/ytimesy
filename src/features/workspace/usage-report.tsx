// biome-ignore-all lint/a11y/useSemanticElements: button groups and an SVG day grid; the native elements (fieldset, table) bring their own borders and layout
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
	formatTokens,
	type HeatmapFilter,
	USAGE_PROVIDER_LABELS,
	USAGE_PROVIDERS,
} from "#/domain/usage-heatmap";
import {
	type Breakdown,
	heatmapDays,
	summarizeUsage,
	USAGE_RANGES,
	type UsageDailyRow,
	type UsageRange,
	type UsageSummary,
} from "#/domain/usage-report";
import { UsageHeatmap } from "./usage-heatmap";
import { usageReportFn } from "./usage-report.fn";

const SOURCE_LABELS: Record<string, string> = {
	box: "Turn boxes",
	"durable-object": "Durable Objects",
	y2: "Y²",
};

function Change({ summary }: { summary: UsageSummary }) {
	if (!summary.previous) return <span>all time</span>;
	if (summary.changeShare === null)
		return <span>no usage in the previous period</span>;
	const percent = Math.round(summary.changeShare * 100);
	return (
		<span>
			{percent >= 0 ? "+" : ""}
			{percent}% vs previous ({formatTokens(summary.previous.totalTokens)})
		</span>
	);
}

function BreakdownList({
	title,
	items,
	label = (_key: string, fallback: string) => fallback,
	provider = false,
}: {
	title: string;
	items: Breakdown;
	label?: (key: string, fallback: string) => string;
	provider?: boolean;
}) {
	return (
		<section aria-label={title}>
			<h4>{title}</h4>
			{items.length ? (
				<ol>
					{items.slice(0, 8).map((item) => (
						<li key={item.key}>
							{provider ? (
								<i
									className="usage-report-dot"
									data-provider={item.key}
									aria-hidden="true"
								/>
							) : null}
							<span title={item.label}>{label(item.key, item.label)}</span>
							<span>{formatTokens(item.totals.totalTokens)}</span>
							<span>{Math.round(item.share * 100)}%</span>
						</li>
					))}
				</ol>
			) : (
				<p className="settings-copy">Nothing in this range.</p>
			)}
		</section>
	);
}

/** The report itself, from rows; the page wraps it in a query, previews and tests pass rows directly. */
export function UsageReportView({
	rows,
	today,
}: {
	rows: readonly UsageDailyRow[];
	today: string;
}) {
	const [range, setRange] = useState<UsageRange>("30d");
	const [filter, setFilter] = useState<HeatmapFilter>("all");
	const summary = useMemo(
		() => summarizeUsage(rows, range, today),
		[rows, range, today],
	);
	const days = useMemo(() => heatmapDays(rows), [rows]);
	const { current } = summary;
	return (
		<div className="settings-group settings-group-body usage-report">
			<div className="usage-report-head" role="group" aria-label="Range">
				{USAGE_RANGES.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className="usage-report-chip"
						aria-pressed={range === entry.id}
						onClick={() => setRange(entry.id)}
					>
						{entry.label}
					</button>
				))}
			</div>
			<div className="usage-report-figures">
				<div>
					<strong>{formatTokens(current.totalTokens)}</strong>
					<span>tokens spent</span>
					<br />
					<span>
						<Change summary={summary} />
					</span>
				</div>
				<div>
					<strong>{formatTokens(current.inputTokens)}</strong>
					<span>input</span>
				</div>
				<div>
					<strong>{formatTokens(current.outputTokens)}</strong>
					<span>output</span>
				</div>
				<div>
					<strong>{formatTokens(current.cacheReadTokens)}</strong>
					<span>cached (part of input)</span>
				</div>
				<div>
					<strong>{current.turns}</strong>
					<span>turns</span>
				</div>
			</div>
			{current.unknownTurns ? (
				<p className="settings-copy">
					{current.unknownTurns} {current.unknownTurns === 1 ? "turn" : "turns"}{" "}
					on a subscription or a provider that reports no token counts: not
					included above. Reasoning tokens are not recorded separately.
				</p>
			) : null}
			<div
				className="usage-report-controls"
				role="group"
				aria-label="Heatmap provider"
			>
				{(["all", ...USAGE_PROVIDERS] as const).map((id) => (
					<button
						key={id}
						type="button"
						className="usage-report-chip"
						aria-pressed={filter === id}
						onClick={() => setFilter(id)}
					>
						{id !== "all" ? (
							<i
								className="usage-report-dot"
								data-provider={id}
								aria-hidden="true"
							/>
						) : null}{" "}
						{id === "all" ? "All" : USAGE_PROVIDER_LABELS[id]}
					</button>
				))}
			</div>
			<UsageHeatmap data={days} today={today} filter={filter} />
			<p className="settings-copy">
				Days are UTC. In All, a day takes the colour of the provider with the
				most tokens.
			</p>
			<div className="usage-report-lists">
				<BreakdownList
					title="By provider"
					items={summary.byProvider}
					provider
					label={(key) =>
						USAGE_PROVIDER_LABELS[key as keyof typeof USAGE_PROVIDER_LABELS]
					}
				/>
				<BreakdownList title="By model" items={summary.byModel} />
				<BreakdownList title="By project" items={summary.byProject} />
				<BreakdownList
					title="By where it ran"
					items={summary.bySource}
					label={(key, fallback) => SOURCE_LABELS[key] ?? fallback}
				/>
			</div>
		</div>
	);
}

export function UsageReport() {
	const read = useServerFn(usageReportFn);
	const report = useQuery({
		queryKey: ["usage-report"],
		queryFn: () => read(),
		staleTime: 60_000,
		retry: false,
	});
	return (
		<section className="settings-section" aria-label="Token usage">
			<header className="settings-section-head">
				<div>
					<h3>Tokens</h3>
					<p>Tokens spent by your chats, by provider, model and project.</p>
				</div>
			</header>
			{report.isPending ? (
				<p className="settings-copy">Loading usage…</p>
			) : null}
			{report.error ? (
				<div className="settings-inline-error">
					<p role="alert">Token usage is unavailable.</p>
					<button
						type="button"
						className="settings-secondary"
						onClick={() => void report.refetch()}
					>
						Retry
					</button>
				</div>
			) : null}
			{report.data ? (
				<UsageReportView rows={report.data.rows} today={report.data.today} />
			) : null}
		</section>
	);
}
