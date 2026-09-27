import { Paperclip, Zap } from "lucide-react";
import { useRef } from "react";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Toggle } from "#/components/ui/toggle";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "#/components/ui/tooltip";
import type { AgentProviderId } from "#/domain/agent-provider";
import { HarnessPicker } from "./harness-picker";
import { resolveReasoningLevel, type SessionModel } from "./model-capabilities";
import { ReasoningOption } from "./reasoning-option";

interface SessionControlsProps {
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	models: readonly SessionModel[];
	modelId: string;
	onModelIdChange: (id: string) => void;
	onAttachFiles: (files: File[]) => void;
	listedModelId?: string;
	reasoningId: string;
	onReasoningIdChange: (id: string) => void;
	fast: boolean;
	onFastChange: (fast: boolean) => void;
	onConnect: () => void;
	catalogStatus: "loading" | "error" | "ready";
	providerConnected: boolean;
}

export function SessionControls({
	harnessId,
	onHarnessIdChange,
	models,
	modelId,
	onModelIdChange,
	onAttachFiles,
	listedModelId = "",
	reasoningId,
	onReasoningIdChange,
	fast,
	onFastChange,
	onConnect,
	catalogStatus,
	providerConnected,
}: SessionControlsProps) {
	const fileInput = useRef<HTMLInputElement>(null);
	const model = models.find((candidate) => candidate.id === modelId);
	const reasoning = resolveReasoningLevel(model, reasoningId);
	const selectedModelId =
		model?.id ??
		models.find((candidate) => candidate.id === listedModelId)?.id ??
		"";
	return (
		<div className="session-controls">
			<input
				ref={fileInput}
				type="file"
				multiple
				hidden
				onChange={(event) => {
					onAttachFiles(Array.from(event.currentTarget.files ?? []));
					event.currentTarget.value = "";
				}}
			/>
			<button
				type="button"
				className="composer-control attachment-control"
				aria-label="Attach files"
				title="Attach files"
				onClick={() => fileInput.current?.click()}
			>
				<Paperclip className="size-4" />
			</button>
			<HarnessPicker
				harnessId={harnessId}
				models={models}
				modelId={selectedModelId}
				modelsEnabled={models.length > 0}
				onConnect={onConnect}
				catalogStatus={catalogStatus}
				providerConnected={providerConnected}
				onModelIdChange={(id) => {
					onModelIdChange(id);
					onReasoningIdChange("");
					onFastChange(false);
				}}
				onHarnessIdChange={(id) => {
					onHarnessIdChange(id);
					onModelIdChange("");
					onReasoningIdChange("");
					onFastChange(false);
				}}
			/>
			{!model?.reasoning ? null : (
				<Select
					value={reasoning?.id ?? ""}
					onValueChange={onReasoningIdChange}
					disabled={models.length === 0}
				>
					<SelectTrigger
						className="composer-select reasoning-select"
						aria-label="Reasoning level"
					>
						<SelectValue placeholder="Reasoning" />
					</SelectTrigger>
					<SelectContent
						position="popper"
						side="top"
						align="start"
						sideOffset={8}
					>
						<SelectGroup>
							<SelectLabel>Reasoning</SelectLabel>
							{model?.reasoning?.levels.map((option, index, levels) => (
								<SelectItem
									key={option.id}
									value={option.id}
									textValue={option.label}
								>
									<ReasoningOption
										label={option.label}
										level={index + 1}
										levelCount={levels.length}
									/>
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			)}
			{!model?.supportsFastMode ? null : (
				<TooltipProvider delayDuration={350}>
					<Tooltip>
						<TooltipTrigger asChild>
							<Toggle
								className="composer-control fast-control"
								aria-label="Fast mode"
								pressed={fast}
								onPressedChange={onFastChange}
							>
								<Zap className="size-4" fill={fast ? "currentColor" : "none"} />
							</Toggle>
						</TooltipTrigger>
						<TooltipContent side="bottom" sideOffset={8}>
							{`Fast mode ${fast ? "on" : "off"}`}
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
			)}
		</div>
	);
}
