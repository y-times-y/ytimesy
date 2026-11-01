import { IMPORT_CODE_TTL_MS } from "./local-import";

/** The CLI command the local agent runs; the code is its only argument. */
export function localImportCommand(code: string) {
	return `npx -y ytimesy continue --code ${code}`;
}

/**
 * What "Copy prompt" puts on the clipboard, for the user to paste into their
 * local coding agent: the command with its one-time code, and what the agent
 * must and must not do while the CLI imports. Short enough to paste.
 */
export function localImportPrompt(code: string) {
	const minutes = Math.round(IMPORT_CODE_TTL_MS / 60_000);
	return `Move my coding sessions to ytimesy, my cloud coding agent. Run:

${localImportCommand(code)}

The code works once and expires in ${minutes} minutes. Follow the CLI's output, and:
- Ask me what to import: this session, all sessions for this project, or everything on this machine. Show me the plan the CLI prints before going on.
- Never open, print or read .env files yourself. The CLI reads .env and .env.local and uploads them directly.
- Ask me before pushing anything from a repository other than this one, and before creating a new repository.
- Ask me before pushing untracked files the CLI lists as risky. In a public repository, ask before pushing any untracked file.
- When it finishes, list the files pushed and anything skipped.
- Then tell me "Done — open <link>" with the link the CLI prints.`;
}
