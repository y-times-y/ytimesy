import {
	ArrowLeftRight,
	BookOpen,
	Brain,
	FilePenLine,
	Files,
	FileText,
	FlaskConical,
	Globe,
	Hourglass,
	Image,
	ListChecks,
	MessageSquare,
	Plug,
	Search,
	Square,
	SquareTerminal,
	TriangleAlert,
	Wrench,
} from "lucide-react";
import type { SessionActivityGlyph } from "#/domain/session-activity";

const icons = {
	thinking: Brain,
	plan: ListChecks,
	shell: SquareTerminal,
	search: Search,
	read: FileText,
	edit: FilePenLine,
	files: Files,
	web: Globe,
	mcp: Plug,
	error: TriangleAlert,
	tool: Wrench,
	wait: Hourglass,
	message: MessageSquare,
	image: Image,
	guide: BookOpen,
	stop: Square,
	test: FlaskConical,
	switch: ArrowLeftRight,
} as const;

export function ActivityIcon({ glyph }: { glyph: SessionActivityGlyph }) {
	const Icon = icons[glyph];
	return <Icon size={14} strokeWidth={1.5} aria-hidden="true" />;
}
