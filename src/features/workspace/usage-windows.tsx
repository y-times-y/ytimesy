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

export type PickerUsageBar = {
	readonly id: string;
	readonly label: string;
	readonly usedPercent: number;
	readonly low: boolean;
	/** The tooltip: when the window refills. */
	readonly detail?: string;
};

/** One labelled line of compact usage bars at the bottom of the model picker. */
export function PickerUsageLine({
	label,
	bars,
}: {
	label: string;
	bars: readonly PickerUsageBar[];
}) {
	if (!bars.length) return null;
	return (
		<section className="model-picker-usage" aria-label={`${label} usage`}>
			<span className="model-picker-usage-label">{label}</span>
			{bars.map((bar) => (
				<div
					key={bar.id}
					className="model-picker-usage-window"
					title={bar.detail}
				>
					<span>{bar.label}</span>
					{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
					<span
						className="model-picker-usage-bar"
						data-tone={bar.low ? "low" : undefined}
						role="meter"
						aria-label={`${bar.label} ${label} usage`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={bar.usedPercent}
					>
						<span style={{ width: `${bar.usedPercent}%` }} />
					</span>
					<span>{bar.usedPercent}%</span>
				</div>
			))}
		</section>
	);
}

/** The cloud usage windows' line in the model picker. Nothing where usage is not metered. */
export function ModelPickerUsage({
	windows,
}: {
	windows: readonly UsageWindowState[] | undefined;
}) {
	return (
		<PickerUsageLine
			label="Cloud"
			bars={(windows ?? []).map((window) => ({
				id: window.id,
				label:
					window.id === "five_hour"
						? "5h"
						: window.id === "weekly"
							? "Week"
							: (USAGE_WINDOWS.find((entry) => entry.id === window.id)?.label ??
								window.id),
				usedPercent: window.usedPercent,
				low: window.usedPercent >= LOW_PERCENT,
				detail: window.resetsAt
					? `${window.exhausted ? "New work resumes" : "Starts to refill"} ${usageResetLabel(window.resetsAt)}`
					: undefined,
			}))}
		/>
	);
}
