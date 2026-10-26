import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
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

/** The cloud usage windows; the model picker reads them before it opens. */
export function useCloudUsageWindows() {
	const readUsage = useServerFn(infrastructureUsageFn);
	return useQuery({
		queryKey: ["infrastructure-usage"],
		queryFn: () => readUsage(),
		staleTime: 60_000,
		retry: false,
	}).data?.windows;
}

/**
 * One compact line at the bottom of the model picker: each usage window's
 * fill. Nothing where usage is not metered.
 */
export function ModelPickerUsage({
	windows,
}: {
	windows: readonly UsageWindowState[] | undefined;
}) {
	if (!windows?.length) return null;
	return (
		<section className="model-picker-usage" aria-label="Cloud usage">
			{windows.map((window) => {
				const label =
					window.id === "five_hour"
						? "5h"
						: window.id === "weekly"
							? "Week"
							: (USAGE_WINDOWS.find((entry) => entry.id === window.id)?.label ??
								window.id);
				return (
					<div
						key={window.id}
						className="model-picker-usage-window"
						title={
							window.resetsAt
								? `${window.exhausted ? "New work resumes" : "Starts to refill"} ${usageResetLabel(window.resetsAt)}`
								: undefined
						}
					>
						<span>{label}</span>
						{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
						<span
							className="model-picker-usage-bar"
							data-tone={window.usedPercent >= LOW_PERCENT ? "low" : undefined}
							role="meter"
							aria-label={`${label} cloud usage`}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={window.usedPercent}
						>
							<span style={{ width: `${window.usedPercent}%` }} />
						</span>
						<span>{window.usedPercent}%</span>
					</div>
				);
			})}
		</section>
	);
}
