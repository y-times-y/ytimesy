import {
	Bot,
	CircleCheck,
	Eye,
	Hammer,
	type LucideIcon,
	Search,
	Terminal,
} from "lucide-react";
import type { AgentIcon as AgentIconId } from "#/domain/helper-names";

const ICONS: Record<AgentIconId, LucideIcon> = {
	bot: Bot,
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
