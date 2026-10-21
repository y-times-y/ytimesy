import { Check } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ReactNode } from "react";

export type MemoryMenuChoice = {
	/** null: Personal (or All, for a filter). */
	readonly value: string | null;
	readonly label: string;
	readonly hint?: string;
};

/**
 * A choice of scope as the app's popover menu (the recovery menu's look),
 * never a native select: a trigger the caller styles, then the choices
 * with the current one checked.
 */
export function MemoryScopeMenu({
	label,
	choices,
	value,
	onChoose,
	children,
	align = "start",
}: {
	label: string;
	choices: readonly MemoryMenuChoice[];
	value: string | null | undefined;
	onChoose: (value: string | null) => void;
	/** The trigger: one button element. */
	children: ReactNode;
	align?: "start" | "end";
}) {
	return (
		<DropdownMenu.Root modal={false}>
			<DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="recovery-menu memory-menu"
					sideOffset={6}
					align={align}
				>
					<DropdownMenu.Label className="recovery-menu-label">
						{label}
					</DropdownMenu.Label>
					{choices.map((choice) => (
						<DropdownMenu.Item
							key={choice.value ?? ""}
							onSelect={() => onChoose(choice.value)}
						>
							<Check
								size={14}
								aria-hidden="true"
								style={{ opacity: choice.value === value ? 1 : 0 }}
							/>
							<span className="memory-menu-label">{choice.label}</span>
							{choice.hint ? (
								<span className="memory-menu-hint">{choice.hint}</span>
							) : null}
						</DropdownMenu.Item>
					))}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
