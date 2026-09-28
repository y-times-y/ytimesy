import { Check, Star } from "lucide-react";
import { Switch } from "#/components/ui/switch";
import type { AgentProviderId } from "#/domain/agent-provider";
import {
	type ModelAttemptSlot,
	maxParallelAgents,
	modelAttemptCountChoices,
	modelAttemptTotal,
} from "#/domain/model-attempts";
import { AgentProviderMark } from "./agent-provider-mark";
import type { SessionModel } from "./model-capabilities";

export function MultipleModelsToggle({
	checked,
	onCheckedChange,
}: {
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="model-multiple-toggle">
			<span>Use Multiple Models</span>
			<Switch
				aria-label="Use Multiple Models"
				checked={checked}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}

export function ModelAttemptRows({
	models,
	harnessId,
	modelId,
	modelsEnabled,
	multiple,
	slots,
	favoriteIds,
	onChoose,
	onCountChange,
	onToggleFavorite,
}: {
	models: readonly SessionModel[];
	harnessId: AgentProviderId;
	modelId: string;
	modelsEnabled: boolean;
	multiple: boolean;
	slots: readonly ModelAttemptSlot[];
	favoriteIds: ReadonlySet<string>;
	onChoose: (modelId: string) => void;
	onCountChange: (modelId: string, count: number) => void;
	onToggleFavorite: (modelId: string) => void;
}) {
	return models.map((candidate) => {
		const favorite = favoriteIds.has(candidate.id);
		const slot = slots.find((item) => item.modelId === candidate.id);
		const checked = multiple ? Boolean(slot) : candidate.id === modelId;
		const atCapacity =
			multiple && !checked && modelAttemptTotal(slots) >= maxParallelAgents;
		return (
			<div
				className="model-picker-row"
				key={candidate.id}
				data-selected={checked}
			>
				<button
					type="button"
					className="model-picker-option"
					disabled={!modelsEnabled || atCapacity}
					title={
						atCapacity
							? "Five agents is the maximum"
							: (candidate.notice ?? candidate.label)
					}
					onClick={() => onChoose(candidate.id)}
					{...(multiple
						? { role: "checkbox" as const, "aria-checked": checked }
						: { "aria-pressed": checked })}
				>
					{multiple ? (
						<span
							className="model-attempt-box"
							data-checked={checked}
							aria-hidden="true"
						>
							{checked ? <Check size={12} /> : null}
						</span>
					) : (
						<AgentProviderMark provider={harnessId} size={18} />
					)}
					<span>{candidate.label}</span>
					{!multiple && candidate.id === modelId ? (
						<Check size={14} aria-hidden="true" />
					) : null}
				</button>
				{multiple && slot ? (
					<select
						className="model-attempt-count"
						aria-label={`${candidate.label} copies`}
						value={slot.count}
						onChange={(event) =>
							onCountChange(candidate.id, Number(event.target.value))
						}
					>
						{modelAttemptCountChoices(slots, candidate.id).map((count) => (
							<option key={count} value={count}>
								{count}x
							</option>
						))}
					</select>
				) : (
					<button
						type="button"
						className="model-favorite"
						aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${candidate.label}`}
						aria-pressed={favorite}
						onClick={() => onToggleFavorite(candidate.id)}
					>
						<Star size={15} fill={favorite ? "currentColor" : "none"} />
					</button>
				)}
			</div>
		);
	});
}
