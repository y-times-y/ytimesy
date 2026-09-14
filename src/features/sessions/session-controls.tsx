import { Plus, Zap } from "lucide-react";
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
import { selectedHarnessIsConnected } from "#/domain/harness-access";
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
	models: readonly SessionModel[];
	modelId: string;
	onModelIdChange: (id: string) => void;
	onAttachFiles: (files: File[]) => void;
	snapshotAvailable?: boolean;
}

export function SessionControls({
	harnessId,
	onHarnessIdChange,
	connection,
	apiKeyHints,
	busy,
	onConnect,
	onSaveApiKey,
	models,
	modelId,
	onModelIdChange,
	onAttachFiles,
	snapshotAvailable = false,
}: SessionControlsProps) {
	const fileInput = useRef<HTMLInputElement>(null);
	const [reasoningId, setReasoningId] = useState("");
	const model = models.find((candidate) => candidate.id === modelId);
	const reasoning = resolveReasoningLevel(model, reasoningId);
	const [fast, setFast] = useState(false);
	const harnessReady = selectedHarnessIsConnected(connection, harnessId);
	const harnessName = agentProviderById(harnessId).name;

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
				<Plus className="size-4" />
			</button>
			<HarnessPicker
				harnessId={harnessId}
				connection={connection}
				apiKeyHints={apiKeyHints}
				busy={busy}
				snapshotAvailable={snapshotAvailable}
				onHarnessIdChange={(id) => {
					onHarnessIdChange(id);
					onModelIdChange("");
					setReasoningId("");
					setFast(false);
				}}
				onConnect={onConnect}
				onSaveApiKey={onSaveApiKey}
			/>
			<Select
				value={model?.id ?? ""}
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
							: `Sign in to ${harnessName} to load its models`
					}
				>
					<SelectValue
						placeholder={harnessReady ? "Select model" : "Sign in first"}
					/>
				</SelectTrigger>
				<SelectContent
					position="popper"
					side="bottom"
					align="start"
					sideOffset={8}
				>
					{models.length === 0 ? (
						<SelectItem value="unconnected" disabled>
							{harnessReady
								? `${harnessName} has not listed models yet`
								: `Sign in to ${harnessName} to load its models`}
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
							? `Sign in to ${harnessName} first`
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
							? `Sign in to ${harnessName} first`
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
