import {
	claudeStreamTerminalResult,
	claudeTurnItemsFromStream,
} from "#/domain/claude-stream";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import type { SessionProgress } from "#/domain/session-progress";
import { parseClaudeAuthStatus } from "./claude/login-session";

export type ProgressFiles = Record<string, string | null>;

export const progressAdapters = {
	api: {
		paths: { status: "/tmp/ytimesy-api-progress.json" },
		parse(files: ProgressFiles, sessionId: string): SessionProgress | null {
			try {
				const data = JSON.parse(files.status ?? "null");
				if (
					data?.sessionId !== sessionId ||
					!["running", "completed", "failed", "idle"].includes(data.turnStatus)
				)
					return null;
				return {
					sessionId,
					items: sessionItemsFromUnknown(data.items),
					turnStatus: data.turnStatus,
				};
			} catch {
				return null;
			}
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
