import {
	BookOpen,
	Brain,
	FilePenLine,
	Files,
	FileText,
	FlaskConical,
	Globe,
	Hand,
	Hourglass,
	Image,
	ListChecks,
	MessageSquare,
	Plug,
	Search,
	Square,
	SquareTerminal,
	TriangleAlert,
	Users,
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
	delegate: Users,
	wait: Hourglass,
	message: MessageSquare,
	takeover: Hand,
	image: Image,
	guide: BookOpen,
	stop: Square,
	test: FlaskConical,
} as const;

export function ActivityIcon({ glyph }: { glyph: SessionActivityGlyph }) {
	const Icon = icons[glyph];
	return <Icon size={14} strokeWidth={1.5} aria-hidden="true" />;
}
