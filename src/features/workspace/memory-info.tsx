import { Tooltip } from "radix-ui";
import type { ReactNode } from "react";

/**
 * A title whose tooltip holds the longer explanation, so the page stays
 * short without an extra info icon.
 */
export function MemoryTitleTip({
	tip,
	children,
}: {
	tip: ReactNode;
	children: ReactNode;
}) {
	return (
		<Tooltip.Provider delayDuration={200}>
			<Tooltip.Root>
				<Tooltip.Trigger asChild>
					{/* biome-ignore lint/a11y/noNoninteractiveTabindex: the title is focusable so keyboard users can read its explanation. */}
					<span className="memory-title-tip" tabIndex={0}>
						{children}
					</span>
				</Tooltip.Trigger>
				<Tooltip.Portal>
					<Tooltip.Content className="memory-info-tip" sideOffset={6}>
						{tip}
					</Tooltip.Content>
				</Tooltip.Portal>
			</Tooltip.Root>
		</Tooltip.Provider>
	);
}
