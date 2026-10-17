// Who wrote memory in a memory-eval run: the builder's own tool calls on
// ~/memory (from the chat's stored items) and the memory repo's commits by
// writer (from their messages). Pure; the live script feeds it.
import type { SessionItem } from "../../src/domain/session-item";

/** ~/memory on the builder VM, however a command or path spells it. */
const MEMORY_PATH =
	/(?:~|\$HOME|\$\{HOME\}|\/root|\/home\/[\w.-]+)\/memory(?:\/|\b)/;
const GIT_COMMIT = /\bgit\b[^;&|\n]*\bcommit\b/;

export type ChatMemoryActivity = {
	/** Tool calls of any kind (shell, patch, MCP, dynamic, web search). */
	toolCalls: number;
	/** Tool calls that read or wrote ~/memory. */
	memoryToolCalls: number;
	/** Successful shell commands that ran `git commit` on ~/memory. */
	memoryCommits: number;
	/** Lines the chat's memorySave markers show (agent and save hook together). */
	savedLines: number;
};

export function chatMemoryActivity(
	items: readonly SessionItem[],
): ChatMemoryActivity {
	const activity: ChatMemoryActivity = {
		toolCalls: 0,
		memoryToolCalls: 0,
		memoryCommits: 0,
		savedLines: 0,
	};
	for (const item of items) {
		switch (item.kind) {
			case "commandExecution": {
				activity.toolCalls++;
				if (!MEMORY_PATH.test(item.command)) break;
				activity.memoryToolCalls++;
				if (
					GIT_COMMIT.test(item.command) &&
					(item.exitCode === 0 ||
						(item.exitCode === null && item.status === "completed"))
				)
					activity.memoryCommits++;
				break;
			}
			case "fileChange":
				activity.toolCalls++;
				if (item.changes.some((change) => MEMORY_PATH.test(change.path)))
					activity.memoryToolCalls++;
				break;
			case "dynamicToolCall":
				activity.toolCalls++;
				if (MEMORY_PATH.test(item.input ?? "")) activity.memoryToolCalls++;
				break;
			case "mcpToolCall":
			case "webSearch":
				activity.toolCalls++;
				break;
			case "memorySave":
				activity.savedLines += item.lines.length;
				break;
		}
	}
	return activity;
}

export type RepoCommits = {
	agent: number;
	saveHook: number;
	dream: number;
	/** Repo creation and the eval's seed. */
	setup: number;
};

/**
 * Commit subjects, newest first, by writer: the save hook and dreaming name
 * themselves (src/server/services/memory-jobs.ts); the VM clone script makes
 * "Create memory repo"; the eval seeds with "Seed memory for the eval";
 * anything else was the builder.
 */
export function repoCommitsByWriter(subjects: readonly string[]): RepoCommits {
	const counts: RepoCommits = { agent: 0, saveHook: 0, dream: 0, setup: 0 };
	for (const subject of subjects) {
		if (/\(save hook\)$/.test(subject)) counts.saveHook++;
		else if (subject.startsWith("Dream:")) counts.dream++;
		else if (
			subject === "Create memory repo" ||
			subject === "Seed memory for the eval"
		)
			counts.setup++;
		else counts.agent++;
	}
	return counts;
}

/** Offline checks for --dry-run; returns the failed check names. */
export function writesSelfCheck(): string[] {
	const item = (value: Record<string, unknown>) =>
		({ id: "x", ...value }) as unknown as SessionItem;
	const activity = chatMemoryActivity([
		item({ kind: "userMessage", text: "hi" }),
		item({
			kind: "commandExecution",
			command: "grep -rn pnpm ~/memory",
			status: "completed",
			exitCode: 1,
		}),
		item({
			kind: "commandExecution",
			command:
				"git -C ~/memory add tools.md && git -C ~/memory commit -m pnpm && git -C ~/memory push",
			status: "completed",
			exitCode: 0,
		}),
		item({
			kind: "commandExecution",
			command: "cd $HOME/memory && git commit -m retry",
			status: "failed",
			exitCode: 1,
		}),
		item({
			kind: "commandExecution",
			command: "git commit -m 'project change'",
			status: "completed",
			exitCode: 0,
		}),
		item({
			kind: "fileChange",
			status: "completed",
			changes: [{ path: "/root/memory/tools.md", change: "update" }],
		}),
		item({
			kind: "fileChange",
			status: "completed",
			changes: [{ path: "/root/app/src/memory.ts", change: "update" }],
		}),
		item({ kind: "memorySave", lines: [{ path: "a.md", text: "b" }] }),
	]);
	const commits = repoCommitsByWriter([
		"Remember from chat 1234abcd (save hook)",
		"Dream: merged duplicates",
		"Add pnpm rule",
		"Create memory repo",
		"Seed memory for the eval",
	]);
	const checks: Record<string, boolean> = {
		toolCalls: activity.toolCalls === 6,
		memoryToolCalls: activity.memoryToolCalls === 4,
		memoryCommits: activity.memoryCommits === 1,
		savedLines: activity.savedLines === 1,
		repoCommits:
			commits.agent === 1 &&
			commits.saveHook === 1 &&
			commits.dream === 1 &&
			commits.setup === 2,
	};
	return Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));
}
