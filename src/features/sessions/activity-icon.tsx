import {
	Brain,
	FilePenLine,
	FileText,
	Globe,
	Info,
	type LucideIcon,
	Plug,
	Split,
	SquareTerminal,
} from "lucide-react";
import type { SessionActivityGlyph } from "#/domain/session-activity";

/**
 * One icon per kind of activity, not per tool: think, read, edit, run, web,
 * agents, notices. Status shows by brightness (CSS), never by a new shape.
 */
const think = Brain;
const read = FileText;
const edit = FilePenLine;
const run = SquareTerminal;
const web = Globe;
const agent = Split;
const notice = Info;
/** A connector with no mark of its own; MCP calls show their server's (mcp-server-icon.tsx). */
const connector = Plug;

const icons = {
	thinking: think,
	plan: think,
	read,
	files: read,
	search: read,
	guide: read,
	history: read,
	image: read,
	edit,
	code: edit,
	shell: run,
	test: run,
	stop: run,
	wait: run,
	browser: run,
	tool: run,
	web,
	mcp: connector,
	agent,
	message: agent,
	switch: agent,
	review: agent,
	notice,
	secret: notice,
	error: notice,
} as const satisfies Record<SessionActivityGlyph, LucideIcon>;

export function ActivityIcon({ glyph }: { glyph: SessionActivityGlyph }) {
	const Icon = icons[glyph];
	return <Icon size={14} strokeWidth={1.5} aria-hidden="true" />;
}
