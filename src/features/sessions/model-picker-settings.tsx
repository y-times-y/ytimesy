import { Brain, Zap } from "lucide-react";
import { MenuSelect } from "#/components/ui/menu-select";
import {
	type ComposerSpeed,
	reasoningLevelLabel,
	resolveReasoningLevel,
	type SessionModel,
} from "./model-capabilities";

const SPEED_LABELS = { fast: "Fast", ultrafast: "Ultrafast" } as const;

function speedLabel(speed: SessionModel["speeds"][number], long = true) {
	if (!speed.priceMultiple) return SPEED_LABELS[speed.id];
	return `${SPEED_LABELS[speed.id]} · ${speed.priceMultiple}×${long ? " price" : ""}`;
}

export function ModelPickerSettings({
	model,
	reasoningId,
	onReasoningIdChange,
	speed,
	onSpeedChange,
}: {
	model: SessionModel;
	reasoningId: string;
	onReasoningIdChange?: (id: string) => void;
	speed: ComposerSpeed;
	onSpeedChange?: (speed: ComposerSpeed) => void;
}) {
	const reasoning = resolveReasoningLevel(model, reasoningId);
	const selectedSpeed = model.speeds.find((option) => option.id === speed);
	return (
		<div className="model-picker-settings">
			<p className="model-picker-current">{model.label}</p>
			{model.reasoning && onReasoningIdChange ? (
				<div className="model-picker-setting">
					<Brain size={16} aria-hidden="true" />
					<span>Reasoning</span>
					<MenuSelect
						value={reasoning?.id ?? ""}
						onValueChange={onReasoningIdChange}
						options={model.reasoning.levels.map((option) => ({
							value: option.id,
							label: reasoningLevelLabel(option.id),
						}))}
						className="model-reasoning-select"
						side="right"
						aria-label="Reasoning level"
					/>
				</div>
			) : null}
			{onSpeedChange && model.speeds.length ? (
				<div className="model-picker-setting">
					<Zap size={16} aria-hidden="true" />
					<span>Speed</span>
					<MenuSelect
						value={selectedSpeed?.id ?? "standard"}
						onValueChange={(id) =>
							onSpeedChange(id === "standard" ? "" : (id as ComposerSpeed))
						}
						valueLabel={
							selectedSpeed ? speedLabel(selectedSpeed, false) : "Standard"
						}
						options={[
							{ value: "standard", label: "Standard" },
							...model.speeds.map((option) => ({
								value: option.id,
								label: speedLabel(option),
								textValue: SPEED_LABELS[option.id],
							})),
						]}
						className="model-reasoning-select"
						side="right"
						aria-label="Speed"
					/>
				</div>
			) : null}
		</div>
	);
}
