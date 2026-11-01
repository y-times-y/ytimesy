/**
 * The parts of "Continue your agent session" the browser renders (no Node
 * APIs): agent names, the timeline's handoff card line and the import card's
 * status line. The server-side rules are in local-import.ts.
 */

export const LOCAL_AGENTS = [
	"claude",
	"codex",
	"opencode",
	"pi",
	"grok",
	"gemini",
	"cursor",
] as const;
export type LocalAgent = (typeof LOCAL_AGENTS)[number];

export const LOCAL_AGENT_NAMES: Readonly<Record<LocalAgent, string>> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
	grok: "Grok",
	gemini: "Gemini CLI",
	cursor: "Cursor",
};

export type ImportStatus =
	| "waiting"
	| "connected"
	| "importing"
	| "ready"
	| "failed";

/** The compact card's line: "Continued from Claude Code · 42 turns · Oct 31". */
export function handoffCardLabel(input: {
	readonly tool: LocalAgent;
	readonly turns: number;
	readonly at: string;
}) {
	const date = new Date(input.at);
	const day = Number.isNaN(date.getTime())
		? input.at.slice(0, 10)
		: date.toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				timeZone: "UTC",
			});
	return `Continued from ${LOCAL_AGENT_NAMES[input.tool] ?? input.tool} · ${input.turns} ${input.turns === 1 ? "turn" : "turns"} · ${day}`;
}

export type LocalImportView = {
	readonly id: string;
	readonly status: ImportStatus | "expired";
	readonly sessionsPlanned: number;
	readonly sessionsImported: number;
	readonly projectId: string | null;
	readonly sessionId: string | null;
	readonly message: string | null;
};

/** The import card's one status line. */
export function localImportStatusLine(view: LocalImportView) {
	switch (view.status) {
		case "waiting":
			return "Waiting for your agent…";
		case "expired":
			return "Code expired. Copy a new prompt.";
		case "connected":
			return "Your agent is planning the import…";
		case "importing":
			return view.sessionsPlanned > 0
				? `Importing ${Math.min(view.sessionsImported, view.sessionsPlanned)} of ${view.sessionsPlanned} sessions…`
				: `Importing ${view.sessionsImported} ${view.sessionsImported === 1 ? "session" : "sessions"}…`;
		case "ready":
			return "Ready";
		case "failed":
			return view.message ?? "Import failed. Copy a new prompt.";
	}
}

/** Whether the card stops polling: nothing more will change. */
export function localImportSettled(status: LocalImportView["status"]) {
	return status === "ready" || status === "failed" || status === "expired";
}
