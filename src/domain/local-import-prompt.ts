import { IMPORT_CODE_TTL_MS } from "./local-import";

/** The server the CLI talks to when no --api is given (packages/ytimesy-cli). */
export const CLI_DEFAULT_API = "https://ytimesy.com";

/**
 * The CLI command the local agent runs. `@latest`, so neither an old cached
 * copy nor a local package named ytimesy (our own repo) runs instead; and
 * `--api` when this app is not the CLI's default server, or the code goes to
 * a server that never issued it (dev, preview, pre-launch hosts).
 */
export function localImportCommand(code: string, appUrl?: string) {
	const origin = appUrl ? new URL(appUrl).origin : CLI_DEFAULT_API;
	const api = origin === CLI_DEFAULT_API ? "" : ` --api ${origin}`;
	return `npx -y ytimesy@latest continue --code ${code}${api}`;
}

/**
 * What "Copy prompt" puts on the clipboard, for the user to paste into their
 * local coding agent: the command with its one-time code, and what the agent
 * must and must not do while the CLI imports. Short enough to paste.
 */
export function localImportPrompt(code: string, appUrl?: string) {
	const minutes = Math.round(IMPORT_CODE_TTL_MS / 60_000);
	return `Move my coding sessions to ytimesy, my cloud coding agent. Run:

${localImportCommand(code, appUrl)}

The code works once and expires in ${minutes} minutes. That first run only plans; follow the CLI's output, and:
- Ask me what to import: this session, all sessions for this project, or everything on this machine. Show me the plan the CLI prints before going on, then run the command it prints with my choices.
- Never open, print or read .env files yourself. The CLI lists their variable names; ask me which ones the cloud agent needs (--secrets NAME,NAME, or --no-secrets) and it uploads only those values directly.
- Ask me before pushing anything from a repository other than this one, and before creating a new repository.
- Ask me before pushing the untracked files the CLI lists (--yes-untracked). In a public repository, ask before pushing any untracked file (--yes-public).
- If I decide not to import, run that command with --cancel.
- When it finishes, list the files pushed and anything skipped.
- Then tell me "Done — open <link>" with the link the CLI prints.`;
}
