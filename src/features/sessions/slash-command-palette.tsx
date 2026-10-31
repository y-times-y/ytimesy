import {
	Files,
	FileText,
	FolderTree,
	MessagesSquare,
	Monitor,
	RotateCcw,
	Sparkles,
	Square,
	SquareTerminal,
} from "lucide-react";
import type { SlashCommand, SlashCommandId } from "#/domain/slash-command";

const icons: Record<SlashCommandId, typeof Square> = {
	stop: Square,
	retry: RotateCcw,
	model: Sparkles,
	files: FolderTree,
	diff: Files,
	terminal: SquareTerminal,
	desktop: Monitor,
	side: MessagesSquare,
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
