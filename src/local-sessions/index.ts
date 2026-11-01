/**
 * Reads local coding-agent sessions (Claude Code, Codex, OpenCode, Pi, Grok) into one
 * normalized model, for handing a local session off to the cloud agent. Pure Node.
 */
import os from "node:os";
import { discoverClaudeSessions, readClaudeSession } from "./claude.ts";
import { discoverCodexSessions, readCodexSession } from "./codex.ts";
import { discoverGrokSessions, readGrokSession } from "./grok.ts";
import {
	successfulCommands,
	type TouchedFiles,
	touchedFiles,
} from "./handoff-helpers.ts";
import { canonicalPath, findGitRoot } from "./io.ts";
import { discoverOpencodeSessions, readOpencodeSession } from "./opencode.ts";
import { discoverPiSessions, readPiSession } from "./pi.ts";
import {
	AGENT_TOOLS,
	type AgentTool,
	type LocalSession,
	type ReadOptions,
	type SessionRef,
} from "./types.ts";

export type { TouchedFiles } from "./handoff-helpers.ts";
export {
	digestDroppedTurns,
	redact,
	successfulCommands,
	touchedFiles,
	trimToBudget,
	turnChars,
} from "./handoff-helpers.ts";
export * from "./types.ts";

export interface DiscoveryOptions {
	/** Defaults to the current user's home directory (tests point this at a fixture). */
	home?: string;
	/** Defaults to every supported tool. */
	tools?: readonly AgentTool[];
}

const discoverers: Record<
	AgentTool,
	(root: string, home: string) => SessionRef[]
> = {
	claude: discoverClaudeSessions,
	codex: discoverCodexSessions,
	opencode: discoverOpencodeSessions,
	pi: discoverPiSessions,
	grok: discoverGrokSessions,
};

/** The git work tree root containing `repoPath`, or the path itself when it is not in a repo. */
export function resolveRepositoryRoot(repoPath: string): string {
	return findGitRoot(repoPath) ?? canonicalPath(repoPath);
}

/**
 * Candidate sessions per tool whose cwd is the repository root or inside it, newest
 * first. Uses directory listings, file mtimes and transcript first lines only.
 */
export function discoverSessions(
	repoPath: string,
	options: DiscoveryOptions = {},
): SessionRef[] {
	const root = resolveRepositoryRoot(repoPath);
	const home = options.home ?? os.homedir();
	const refs: SessionRef[] = [];
	for (const tool of options.tools ?? AGENT_TOOLS) {
		try {
			refs.push(...discoverers[tool](root, home));
		} catch {
			// One unreadable store must not hide sessions from the others.
		}
	}
	return refs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The most recently updated session, across all tools, for the repository containing `repoPath`. */
export function findLatestSession(
	repoPath: string,
	options: DiscoveryOptions = {},
): SessionRef | undefined {
	return discoverSessions(repoPath, options)[0];
}

/**
 * Reads a session's conversation. With `budgetChars`, large transcripts are read
 * backwards from the end only as far as needed; pass the result through
 * trimToBudget for the final cut.
 */
export function readSession(
	ref: SessionRef,
	options: ReadOptions = {},
	home = os.homedir(),
): LocalSession {
	switch (ref.tool) {
		case "claude":
			return readClaudeSession(ref, options);
		case "codex":
			return readCodexSession(ref, options);
		case "opencode":
			return readOpencodeSession(ref, options, home);
		case "pi":
			return readPiSession(ref, options);
		case "grok":
			return readGrokSession(ref, options);
	}
}

export interface SessionActivity {
	/** Shell commands that exited 0, in first-run order. */
	successfulCommands: string[];
	files: TouchedFiles;
	toolCallCount: number;
}

/**
 * One forward pass over the whole session that parses only tool call / result
 * records and keeps only commands and paths. Independent of readSession, so a
 * caller can run both in parallel.
 */
export function readSessionActivity(
	ref: SessionRef,
	options: { root?: string; home?: string } = {},
): SessionActivity {
	const session = (() => {
		switch (ref.tool) {
			case "claude":
				return readClaudeSession(ref, { activityOnly: true });
			case "codex":
				return readCodexSession(ref, { activityOnly: true });
			case "opencode":
				return readOpencodeSession(
					ref,
					{ activityOnly: true },
					options.home ?? os.homedir(),
				);
			case "pi":
				return readPiSession(ref, { activityOnly: true });
			case "grok":
				return readGrokSession(ref, { activityOnly: true });
		}
	})();
	return {
		successfulCommands: successfulCommands(session),
		files: touchedFiles(session, {
			root: options.root ?? resolveRepositoryRoot(session.cwd),
		}),
		toolCallCount: session.turns.reduce(
			(sum, turn) => sum + turn.toolCalls.length,
			0,
		),
	};
}

export { claudeProjectsDirectory, claudeSessionRefForFile } from "./claude.ts";
export {
	codexSessionRefForFile,
	codexSessionsDirectory,
	listCodexRolloutFiles,
} from "./codex.ts";
export {
	exportFullTranscript,
	type FullTranscriptOptions,
	type FullTranscriptResult,
} from "./full-transcript.ts";
export { grokSessionRefForDirectory, grokSessionsDirectory } from "./grok.ts";
export { listOpencodeSessionRefs } from "./opencode.ts";
export { piSessionRefForFile, piSessionsDirectory } from "./pi.ts";
