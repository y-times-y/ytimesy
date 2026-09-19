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

export function HarnessPicker({
	harnessId,
	onHarnessIdChange,
}: {
	harnessId: AgentProviderId;
	onHarnessIdChange: (id: AgentProviderId) => void;
}) {
	const options = offeredAgentProviders();
	const selected =
		options.find((option) => option.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);

	if (!selected) return null;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				id="session-harness-select"
				className="composer-select harness-select"
				aria-label="Harness"
				title={selected.name}
			>
				<AgentProviderMark provider={selected.id} size={16} />
				<span>{selected.name}</span>
				<ChevronDown className="size-3" />
			</PopoverTrigger>
			<PopoverContent side="top" className="harness-picker">
				<div
					className="harness-picker-list"
					role="listbox"
					aria-label="Harness"
				>
					{options.map((option) => {
						const selectedOption = option.id === harnessId;
						return (
							<button
								key={option.id}
								type="button"
								role="option"
								aria-selected={selectedOption}
								className="harness-choice"
								data-selected={selectedOption ? "true" : undefined}
								onClick={() => {
									onHarnessIdChange(option.id);
									setOpen(false);
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
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
