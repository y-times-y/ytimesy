import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	USAGE_WINDOW_WARNING_SHARE,
	USAGE_WINDOWS,
	type UsageWindowState,
} from "#/domain/infrastructure-usage";
import { usageResetLabel } from "#/domain/usage-warning";
import { infrastructureUsageFn } from "./infrastructure-usage.fn";

const LOW_PERCENT = USAGE_WINDOW_WARNING_SHARE * 100;

/** The 5-hour and weekly cloud usage windows as bars, like subscription limits. */
export function UsageWindowBars({
	windows,
}: {
	windows: readonly UsageWindowState[];
}) {
	return (
		<>
			{windows.map((window) => (
				<div key={window.id} className="codex-usage-window">
					<div className="codex-usage-line">
						<span>
							{USAGE_WINDOWS.find((entry) => entry.id === window.id)?.label}
						</span>
						<span>{window.usedPercent}% used</span>
					</div>
					{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
					<div
						className="settings-meter"
						data-tone={window.usedPercent >= LOW_PERCENT ? "low" : undefined}
						role="meter"
						aria-label="Cloud usage"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={window.usedPercent}
					>
						<span style={{ width: `${window.usedPercent}%` }} />
					</div>
					{window.resetsAt ? (
						<p className="settings-row-meta">
							{window.exhausted ? "New work resumes" : "Starts to refill"}{" "}
							{usageResetLabel(window.resetsAt)}
						</p>
					) : null}
				</div>
			))}
		</>
	);
}

/**
 * A small ring in the chat toolbar for the fuller usage window; its popover
 * shows both windows. Hidden where usage is not metered.
 */
export function CloudUsageIndicator() {
	const readUsage = useServerFn(infrastructureUsageFn);
	const usage = useQuery({
		queryKey: ["infrastructure-usage"],
		queryFn: () => readUsage(),
		refetchInterval: 60_000,
		retry: false,
	});
	const windows = usage.data?.windows;
	if (!windows?.length) return null;
	const percent = Math.max(...windows.map((window) => window.usedPercent));
	return (
		<Popover>
			<PopoverTrigger
				className="context-usage-trigger"
				data-tone={percent >= LOW_PERCENT ? "low" : undefined}
				aria-label={`Cloud usage: ${percent}% of the fuller limit used`}
			>
				<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
					<rect
						x="3"
						y="10"
						width="18"
						height="4"
						rx="2"
						fill="currentColor"
						fillOpacity="0.2"
					/>
					<rect
						x="3"
						y="10"
						width={(18 * percent) / 100}
						height="4"
						rx="2"
						fill="currentColor"
					/>
				</svg>
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="end"
				collisionPadding={12}
				className="context-usage-popover"
			>
				<div className="context-usage-title">Cloud usage</div>
				<UsageWindowBars windows={windows} />
			</PopoverContent>
		</Popover>
	);
}
