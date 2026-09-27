export const CLAUDE_HOME_FILE_NAMES = [
	".claude.json",
	".claude/.credentials.json",
] as const;

export type ClaudeHomeFileName = (typeof CLAUDE_HOME_FILE_NAMES)[number];

export type ClaudeHomeFiles = {
	readonly files: Readonly<Partial<Record<ClaudeHomeFileName, string>>>;
};

const AUTH_KEY = /oauth|account|hasCompletedOnboarding/i;

/**
 * Claude Code stores the Anthropic session in the guest home. A new chat VM
 * can reuse those files instead of starting another paste-back login.
 */
export function claudeHomeFilesAreUsable(
	files: ClaudeHomeFiles["files"],
): boolean {
	const main = files[".claude.json"]?.trim();
	if (!main) return false;
	try {
		const parsed: unknown = JSON.parse(main);
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return false;
		}
		return Object.keys(parsed).some((key) => AUTH_KEY.test(key));
	} catch {
		return false;
	}
}

export function parseClaudeHomeDump(output: string): ClaudeHomeFiles | null {
	try {
		const parsed: unknown = JSON.parse(output);
		if (typeof parsed !== "object" || parsed === null) return null;
		const raw = (parsed as { files?: unknown }).files;
		if (typeof raw !== "object" || raw === null) return null;
		const files: Partial<Record<ClaudeHomeFileName, string>> = {};
		for (const name of CLAUDE_HOME_FILE_NAMES) {
			const value = (raw as Record<string, unknown>)[name];
			if (typeof value === "string" && value.trim()) files[name] = value;
		}
		return claudeHomeFilesAreUsable(files) ? { files } : null;
	} catch {
		return null;
	}
}

export function claudeSettingsPath(home: string): string {
	const trimmed = home.trim().replace(/\/+$/, "");
	return `${trimmed}/.claude/settings.json`;
}

/**
 * Claude Code redacts thinking unless this is on. The model still thinks;
 * stream-json just omits the text.
 */
export function claudeSettingsShowingThoughts(existing: string | null): string {
	let parsed: Record<string, unknown> = {};
	if (existing?.trim()) {
		try {
			const value: unknown = JSON.parse(existing);
			if (
				typeof value === "object" &&
				value !== null &&
				!Array.isArray(value)
			) {
				parsed = { ...value };
			}
		} catch {
			parsed = {};
		}
	}
	return `${JSON.stringify({ ...parsed, showThinkingSummaries: true }, null, 2)}\n`;
}

export function siblingClaudeHomePaths(home: string): readonly string[] {
	const trimmed = home.trim().replace(/\/+$/, "");
	if (!trimmed || trimmed === ".") return [];
	return CLAUDE_HOME_FILE_NAMES.map((name) => `${trimmed}/${name}`);
}
