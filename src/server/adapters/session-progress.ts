import {
	claudeStreamTerminalResult,
	claudeTurnItemsFromStream,
} from "#/domain/claude-stream";
import type { SessionProgress } from "#/domain/session-progress";
import { parseClaudeAuthStatus } from "./claude/login-session";
import { parseCodexLoginStatus } from "./codex/login-status";

export type ProgressFiles = Record<string, string | null>;

export const progressAdapters = {
	codex: {
		paths: { status: "/tmp/ytimesy-auth-status.json" },
		parse(files: ProgressFiles, sessionId: string): SessionProgress | null {
			const status = parseCodexLoginStatus(files.status);
			return status.stage === "authenticated"
				? { sessionId, items: status.items, turnStatus: status.turnStatus }
				: null;
		},
	},
	claude: {
		paths: {
			status: "/tmp/ytimesy-claude-auth-status.json",
			output: "/tmp/ytimesy-claude-turn.out",
			exit: "/tmp/ytimesy-claude-turn.exit",
		},
		parse(files: ProgressFiles, sessionId: string): SessionProgress | null {
			const status = parseClaudeAuthStatus(files.status);
			if (status.stage !== "authenticated") return null;
			const result = claudeStreamTerminalResult(files.output);
			return {
				sessionId,
				items:
					status.turnStatus === "running"
						? claudeTurnItemsFromStream({
								previousItems: status.items,
								stream: files.output,
							})
						: status.items,
				turnStatus:
					status.turnStatus === "running"
						? (result?.kind ?? "running")
						: status.turnStatus,
			};
		},
	},
} as const;
