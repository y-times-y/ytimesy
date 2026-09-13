import type { SlashCommand } from "#/domain/slash-command";

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
			{commands.map((command, index) => (
				<div key={command.id} role="presentation">
					<button
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						aria-disabled={command.availability !== "ready"}
						disabled={command.availability !== "ready"}
						data-active={index === activeIndex}
						onMouseEnter={() => onHover(index)}
						onClick={() => onSelect(command)}
					>
						<code className="slash-command-trigger">{command.trigger}</code>
						<span className="slash-palette-copy">
							<span>{command.label}</span>
							<small>
								{command.availability === "ready"
									? command.description
									: command.unavailableReason}
							</small>
						</span>
					</button>
				</div>
			))}
		</div>
	);
}
