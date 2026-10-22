import {
	CircleCheck,
	Eye,
	Hammer,
	type LucideIcon,
	Search,
	Terminal,
} from "lucide-react";
import type { AgentIcon as AgentIconId } from "#/domain/helper-names";

const ICONS: Record<Exclude<AgentIconId, "dot">, LucideIcon> = {
	hammer: Hammer,
	search: Search,
	eye: Eye,
	"circle-check": CircleCheck,
	terminal: Terminal,
};

/** An agent's kind icon, tinted with its colour (helper-names.ts). */
export function AgentIcon({
	icon,
	color,
	size = 14,
}: {
	icon: AgentIconId;
	color: string;
	size?: number;
}) {
	// Main has no pictogram: a plain dot in its colour.
	if (icon === "dot")
		return (
			<svg
				className="agent-icon"
				width={size}
				height={size}
				viewBox="0 0 16 16"
				style={{ color }}
				aria-hidden="true"
			>
				<circle cx="8" cy="8" r="3" fill="currentColor" />
			</svg>
		);
	const Icon = ICONS[icon];
	return (
		<Icon
			className="agent-icon"
			size={size}
			strokeWidth={1.5}
			style={{ color }}
			aria-hidden="true"
		/>
	);
}
