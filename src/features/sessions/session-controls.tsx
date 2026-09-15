import { Paperclip, Zap } from "lucide-react";
import { useRef, useState } from "react";
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
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import {
	harnessRequiresAccountLogin,
	selectedHarnessIsConnected,
} from "#/domain/harness-access";
import { listedModelDisplayName } from "#/domain/listed-model";
import { HarnessPicker } from "./harness-picker";
import { resolveReasoningLevel, type SessionModel } from "./model-capabilities";
import { ReasoningOption } from "./reasoning-option";

interface SessionControlsProps {
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	connection: AgentConnection;
	apiKeyHints: Readonly<Partial<Record<AgentProviderId, string>>>;
	busy: boolean;
	onConnect: () => void;
	onSaveApiKey: (harnessId: AgentProviderId, apiKey: string) => void;
	snapshotAvailable?: boolean;
	models: readonly SessionModel[];
	modelId: string;
	onModelIdChange: (id: string) => void;
	onAttachFiles: (files: File[]) => void;
	listedModelId?: string;
}

export function SessionControls({
	harnessId,
	onHarnessIdChange,
	connection,
	apiKeyHints,
	busy,
	onConnect,
	onSaveApiKey,
	snapshotAvailable = false,
	models,
	modelId,
	onModelIdChange,
	onAttachFiles,
	listedModelId = "",
}: SessionControlsProps) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [reasoningId, setReasoningId] = useState("");
	const model = models.find((candidate) => candidate.id === modelId);
	const reasoning = resolveReasoningLevel(model, reasoningId);
	const [fast, setFast] = useState(false);
	const harnessReady = selectedHarnessIsConnected(connection, harnessId);
	const harnessName = agentProviderById(harnessId).name;
	const startPrompt = harnessRequiresAccountLogin(harnessId)
		? `Sign in to ${harnessName}`
		: `Connect ${harnessName}`;
	const persistedModelId = (model?.id || modelId || listedModelId).trim();
	const persistedLabel =
		model?.label || listedModelDisplayName(persistedModelId);

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
				connection={connection}
				apiKeyHints={apiKeyHints}
				busy={busy}
				onHarnessIdChange={(id) => {
					onHarnessIdChange(id);
					onModelIdChange("");
					setReasoningId("");
					setFast(false);
				}}
				onConnect={onConnect}
				onSaveApiKey={onSaveApiKey}
				snapshotAvailable={snapshotAvailable}
			/>
			<Select
				value={persistedModelId || undefined}
				onValueChange={(id) => {
					onModelIdChange(id);
					setReasoningId("");
					setFast(false);
				}}
				disabled={!harnessReady}
			>
				<SelectTrigger
					id="session-model-select"
					className="composer-select model-select"
					aria-label="Model"
					title={
						harnessReady
							? undefined
							: persistedLabel
								? `${startPrompt} to change models`
								: `${startPrompt} to load its models`
					}
				>
					{harnessReady ? (
						<SelectValue placeholder={startPrompt} />
					) : (
						<span data-slot="select-value">
							{persistedLabel || startPrompt}
						</span>
					)}
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="bottom"
					align="start"
					sideOffset={8}
				>
					{models.length === 0 && persistedModelId ? (
						<SelectItem value={persistedModelId} disabled>
							{persistedLabel}
						</SelectItem>
					) : models.length === 0 ? (
						<SelectItem value="unconnected" disabled>
							{startPrompt} to load its models
						</SelectItem>
					) : (
						models.map((availableModel) => (
							<SelectItem key={availableModel.id} value={availableModel.id}>
								{availableModel.label}
							</SelectItem>
						))
					)}
				</SelectContent>
			</Select>
			<Select
				value={reasoning?.id ?? ""}
				onValueChange={setReasoningId}
				disabled={!harnessReady || !model?.reasoning}
			>
				<SelectTrigger
					className="composer-select reasoning-select"
					aria-label="Reasoning level"
					title={
						!harnessReady
							? `${startPrompt} first`
							: !model
								? "Select a model to see its reasoning levels"
								: !model.reasoning
									? "This model has no configurable reasoning levels"
									: undefined
					}
				>
					<SelectValue placeholder="Reasoning" />
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="bottom"
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
			<TooltipProvider delayDuration={350}>
				<Tooltip>
					<TooltipTrigger asChild>
						<Toggle
							className="composer-control fast-control"
							aria-label="Fast mode"
							disabled={!model?.supportsFastMode}
							pressed={Boolean(model?.supportsFastMode && fast)}
							onPressedChange={setFast}
						>
							<Zap
								className="size-4"
								fill={model?.supportsFastMode && fast ? "currentColor" : "none"}
							/>
						</Toggle>
					</TooltipTrigger>
					<TooltipContent side="bottom" sideOffset={8}>
						{!harnessReady
							? `${startPrompt} first`
							: !model
								? "Select a model first"
								: !model.supportsFastMode
									? "Fast mode unavailable for this model"
									: `Fast mode ${fast ? "on" : "off"}`}
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);
}
