import { Brain, Zap } from "lucide-react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Toggle } from "#/components/ui/toggle";
import {
	type ComposerSpeed,
	reasoningLevelLabel,
	resolveReasoningLevel,
	type SessionModel,
} from "./model-capabilities";

const SPEED_LABELS = { fast: "Fast", ultrafast: "Ultrafast" } as const;

function speedLabel(speed: SessionModel["speeds"][number]) {
	return speed.priceMultiple
		? `${SPEED_LABELS[speed.id]} · ${speed.priceMultiple}× price`
		: SPEED_LABELS[speed.id];
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
	const [onlySpeed] = model.speeds;
	const selectedSpeed = model.speeds.find((option) => option.id === speed);
	return (
		<div className="model-picker-settings">
			<p className="model-picker-current">{model.label}</p>
			{model.reasoning && onReasoningIdChange ? (
				<div className="model-picker-setting">
					<Brain size={17} aria-hidden="true" />
					<span>Reasoning</span>
					<Select
						value={reasoning?.id ?? ""}
						onValueChange={onReasoningIdChange}
					>
						<SelectTrigger
							className="model-reasoning-select"
							aria-label="Reasoning level"
						>
							<SelectValue>
								{reasoning ? reasoningLevelLabel(reasoning.id) : null}
							</SelectValue>
						</SelectTrigger>
						<SelectContent position="popper" side="right">
							{model.reasoning.levels.map((option) => (
								<SelectItem
									key={option.id}
									value={option.id}
									textValue={reasoningLevelLabel(option.id)}
								>
									{reasoningLevelLabel(option.id)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			{onlySpeed && onSpeedChange && model.speeds.length === 1 ? (
				<div className="model-picker-setting">
					<Zap size={17} aria-hidden="true" />
					<span>
						Fast mode
						{onlySpeed.priceMultiple
							? ` · ${onlySpeed.priceMultiple}× price`
							: null}
					</span>
					<Toggle
						aria-label="Fast mode"
						pressed={speed === onlySpeed.id}
						onPressedChange={(on) => onSpeedChange(on ? onlySpeed.id : "")}
					>
						{speed === onlySpeed.id ? "On" : "Off"}
					</Toggle>
				</div>
			) : null}
			{onSpeedChange && model.speeds.length > 1 ? (
				<div className="model-picker-setting">
					<Zap size={17} aria-hidden="true" />
					<span>Speed</span>
					<Select
						value={selectedSpeed?.id ?? "standard"}
						onValueChange={(id) =>
							onSpeedChange(id === "standard" ? "" : (id as ComposerSpeed))
						}
					>
						<SelectTrigger
							className="model-reasoning-select"
							aria-label="Speed"
						>
							<SelectValue>
								{selectedSpeed ? SPEED_LABELS[selectedSpeed.id] : "Standard"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent position="popper" side="right">
							<SelectItem value="standard" textValue="Standard">
								Standard
							</SelectItem>
							{model.speeds.map((option) => (
								<SelectItem
									key={option.id}
									value={option.id}
									textValue={SPEED_LABELS[option.id]}
								>
									{speedLabel(option)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
		</div>
	);
}
