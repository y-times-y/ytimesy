import { Info } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ReactNode } from "react";

/** A small (i) whose tooltip holds the longer explanation, so the page stays short. */
export function MemoryInfo({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Tooltip.Provider delayDuration={150}>
			<Tooltip.Root>
				<Tooltip.Trigger asChild>
					<button type="button" className="memory-info" aria-label={label}>
						<Info size={13} aria-hidden="true" />
					</button>
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content className="memory-info-tip" sideOffset={6}>
						{children}
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	);
}
