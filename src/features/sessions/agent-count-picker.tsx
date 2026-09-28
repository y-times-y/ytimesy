import { Check, ChevronDown, Copy } from "lucide-react";
import { useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { Switch } from "#/components/ui/switch";

interface AgentCountPickerProps {
	value: number;
	onChange: (count: number) => void;
}

export function AgentCountPicker({ value, onChange }: AgentCountPickerProps) {
	const [open, setOpen] = useState(false);
	const multipleAgents = value > 1;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				type="button"
				className="competition-picker-trigger"
				data-active={multipleAgents}
				aria-label={
					multipleAgents
						? `${value} parallel attempts at the same task`
						: "Run parallel attempts at the same task"
				}
			>
				<Copy size={15} strokeWidth={1.6} aria-hidden="true" />
				<span>
					{multipleAgents ? `${value} attempts` : "Parallel attempts"}
				</span>
				{multipleAgents ? (
					<span className="competition-picker-count-badge" aria-hidden="true">
						{value}
					</span>
				) : null}
				<ChevronDown size={12} aria-hidden="true" />
			</PopoverTrigger>
			<PopoverContent
				side="top"
				align="end"
				collisionPadding={12}
				className="competition-picker-popover"
			>
				<div className="competition-picker-heading">
					<div>
						<strong>Same task, multiple agents</strong>
						<p>
							Independent attempts give the judge more solutions to choose from.
						</p>
					</div>
					<Switch
						aria-label="Run multiple agents on the same task"
						checked={multipleAgents}
						onCheckedChange={(checked) => onChange(checked ? 2 : 1)}
					/>
				</div>
				{multipleAgents ? (
					<div className="competition-picker-count">
						<div className="competition-picker-count-label">
							<span>Agents</span>
							<span>2–5 independent runs</span>
						</div>
						<fieldset
							className="competition-picker-options"
							aria-label="Number of independent agents"
						>
							{[2, 3, 4, 5].map((count) => (
								<button
									key={count}
									type="button"
									aria-pressed={value === count}
									onClick={() => onChange(count)}
								>
									{count}
									{value === count ? (
										<Check size={12} aria-hidden="true" />
									) : null}
								</button>
							))}
						</fieldset>
						<p>Uses more compute and waits for every agent to finish.</p>
					</div>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
