import { Check, ChevronDown } from "lucide-react";
import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import {
	type AgentProviderId,
	offeredAgentProviders,
} from "#/domain/agent-provider";
import { AgentProviderMark } from "./agent-provider-mark";
import type { SessionModel } from "./model-capabilities";

export function HarnessPicker({
	harnessId,
	onHarnessIdChange,
	models,
	modelId,
	onModelIdChange,
	modelsEnabled,
	onConnect,
	catalogStatus = "ready",
	providerConnected = false,
}: {
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
	models: readonly SessionModel[];
	modelId: string;
	onModelIdChange: (id: string) => void;
	modelsEnabled: boolean;
	onConnect?: () => void;
	catalogStatus?: "loading" | "error" | "ready";
	providerConnected?: boolean;
}) {
	const options = offeredAgentProviders();
	const selected =
		options.find((option) => option.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);
	const model = models.find((candidate) => candidate.id === modelId);

	if (!selected) return null;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				id="session-harness-select"
				className="composer-select harness-select"
				aria-label="Model"
				title={`${selected.name}${model ? ` · ${model.label}` : ""}`}
			>
				<AgentProviderMark provider={selected.id} size={16} />
				<span>{model?.label ?? "Select model"}</span>
				<ChevronDown className="size-3" />
			</PopoverTrigger>
			<PopoverContent side="top" className="harness-picker">
				<div className="harness-picker-list">
					{options.map((option) => {
						const selectedOption = option.id === harnessId;
						return (
							<section key={option.id} aria-label={option.name}>
								<button
									type="button"
									aria-pressed={selectedOption}
									className="harness-choice"
									data-selected={selectedOption ? "true" : undefined}
									onClick={() => {
										if (!selectedOption) onHarnessIdChange(option.id);
									}}
								>
									<span className="harness-choice-mark">
										<AgentProviderMark provider={option.id} size={16} />
									</span>
									<span className="harness-choice-name">{option.name}</span>
									{selectedOption ? (
										<Check className="harness-choice-check" size={14} />
									) : null}
								</button>
								{selectedOption ? (
									models.length ? (
										models.map((availableModel) => (
											<button
												key={availableModel.id}
												type="button"
												className="harness-choice model-choice"
												aria-pressed={availableModel.id === modelId}
												disabled={!modelsEnabled}
												onClick={() => {
													onModelIdChange(availableModel.id);
													setOpen(false);
												}}
											>
												<span className="harness-choice-name">
													{availableModel.label}
												</span>
												{availableModel.id === modelId ? (
													<Check size={14} />
												) : null}
											</button>
										))
									) : (
										<div aria-busy={catalogStatus === "loading"}>
											<p className="model-picker-status" role="status">
												{catalogStatus === "loading"
													? null
													: catalogStatus === "error"
														? "Could not load saved models"
														: providerConnected
															? "No saved model list yet"
															: "Connect this provider once to discover its models"}
											</p>
											{onConnect && catalogStatus !== "loading" ? (
												<button
													type="button"
													className="harness-choice model-choice"
													onClick={() => {
														setOpen(false);
														onConnect();
													}}
												>
													{catalogStatus === "error"
														? "Retry"
														: providerConnected
															? "Refresh models"
															: "Connect provider"}
												</button>
											) : null}
										</div>
									)
								) : null}
							</section>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
