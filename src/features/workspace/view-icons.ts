import {
	BookMarked,
	FolderTree,
	GitCompare,
	GitPullRequest,
	type LucideIcon,
	MessagesSquare,
	Monitor,
	SquareTerminal,
} from "lucide-react";

/**
 * One icon per right-sidebar view, shared by its tab, the + menu, the
 * Overview cards and the slash commands that open it.
 */
export const VIEW_ICONS = {
	files: FolderTree,
	diff: GitCompare,
	pr: GitPullRequest,
	terminal: SquareTerminal,
	desktop: Monitor,
	memory: BookMarked,
	side: MessagesSquare,
} as const satisfies Record<string, LucideIcon>;
