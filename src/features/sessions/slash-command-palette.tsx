import { FileText, type LucideIcon, RotateCcw, Sparkles } from "lucide-react";
import type { SlashCommand, SlashCommandId } from "#/domain/slash-command";
import { VIEW_ICONS } from "../workspace/view-icons";

/** Commands that open a right-sidebar view use that view's icon. */
const icons: Record<SlashCommandId, LucideIcon> = {
	retry: RotateCcw,
	model: Sparkles,
	files: VIEW_ICONS.files,
	diff: VIEW_ICONS.diff,
	terminal: VIEW_ICONS.terminal,
	desktop: VIEW_ICONS.desktop,
	side: VIEW_ICONS.side,
	custom: FileText,
};

export function SlashCommandPalette({
	commands,
	activeIndex,
	onHover,
	onSelect,
}: {
	commands: readonly SlashCommand[];
	activeIndex: number;
	onHover: (index: number) => void;
	onSelect: (command: SlashCommand) => void;
}) {
	if (commands.length === 0) return null;
	return (
		<div className="slash-palette" role="listbox" aria-label="Slash commands">
			{commands.map((command, index) => {
				const Icon = icons[command.id];
				const ready = command.availability === "ready";
				return (
					<div key={command.trigger} role="presentation">
						<button
							type="button"
							role="option"
							aria-selected={index === activeIndex}
							aria-disabled={!ready}
							title={ready ? command.description : command.unavailableReason}
							data-active={index === activeIndex}
							onMouseEnter={() => onHover(index)}
							onClick={() => {
								if (ready) onSelect(command);
							}}
						>
							<Icon size={16} />
							{/* The description is the row's tooltip, not a second line. */}
							<span className="slash-palette-copy">
								<span>{command.label}</span>
							</span>
							<code className="slash-command-trigger">
								{command.argumentHint
									? `${command.trigger} ${command.argumentHint}`
									: command.trigger}
							</code>
						</button>
					</div>
				);
			})}
		</div>
	);
}
