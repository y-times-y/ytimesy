import { Brain, Layers, Zap } from "lucide-react";
import { MenuSelect } from "#/components/ui/menu-select";
import { contextWindowLabel } from "#/domain/context-window-option";
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
	alternateContext = false,
	onAlternateContextChange,
}: {
	model: SessionModel;
	reasoningId: string;
	onReasoningIdChange?: (id: string) => void;
	speed: ComposerSpeed;
	onSpeedChange?: (speed: ComposerSpeed) => void;
	alternateContext?: boolean;
	onAlternateContextChange?: (alternate: boolean) => void;
}) {
	const reasoning = resolveReasoningLevel(model, reasoningId);
	const selectedSpeed = model.speeds.find((option) => option.id === speed);
	const window = model.contextWindow;
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
			{onAlternateContextChange && window ? (
				<div className="model-picker-setting">
					<Layers size={16} aria-hidden="true" />
					<span>Context</span>
					<MenuSelect
						value={alternateContext ? "alternate" : "standard"}
						onValueChange={(id) => onAlternateContextChange(id === "alternate")}
						options={[
							{
								value: "standard",
								label: contextWindowLabel(window.standard),
							},
							{
								value: "alternate",
								label: contextWindowLabel(window.alternate),
								...(window.note ? { title: window.note } : {}),
							},
						].sort(
							(a, b) =>
								(a.value === "standard" ? window.standard : window.alternate) -
								(b.value === "standard" ? window.standard : window.alternate),
						)}
						className="model-reasoning-select"
						side="right"
						aria-label="Context window"
					/>
				</div>
			) : null}
		</div>
	);
}
