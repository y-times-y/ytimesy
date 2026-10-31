import { EVIDENCE_END, EVIDENCE_START } from "./pr-evidence";
import type { SessionItem } from "./session-item";

const PULL_REQUEST_START = "<pull-request>";
const PULL_REQUEST_END = "</pull-request>";
const CHANGE_NOTE =
	"Comment `@ytimesy <what to change>` on this pull request to ask for a change.";

/** Body used when the turn did not say what changed. Not a stand-in description. */
export const PULL_REQUEST_DESCRIPTION_MISSING =
	"No description of this change was available from this turn, so none was invented.";

export type HandoffVerification = {
	readonly command: string;
	readonly exitCode: number | null;
};

/** What the turn itself recorded for the pull request description. */
export type PullRequestHandoffFacts = {
	readonly description: string | null;
	readonly finalAnswer: string | null;
	readonly files: readonly string[];
	readonly verification: readonly HandoffVerification[];
};

const CHECK_COMMAND =
	/\b(test|tests|check|lint|typecheck|tsc|pytest|vitest|jest|playwright|cypress|cargo|go test|npm |pnpm |yarn |bun |ytimesy-browser|ytimesy-evidence|ytimesy-check)\b/i;
const TRIVIAL_COMMAND =
	/^(?:cd|ls|pwd|true|false|echo|cat|head|tail|find|rg|git status|git diff|git log)\b/;
const SECRET_COMMAND =
	/ghp_|github_pat_|sk-|Bearer |x-access-token|AKIA[A-Z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY/i;

/** The agent's `<pull-request>` description, or null when it is missing or boilerplate. */
export function agentPullRequestDescription(
	finalAnswer: string | null | undefined,
) {
	if (!finalAnswer) return null;
	const start = finalAnswer.lastIndexOf(PULL_REQUEST_START);
	const end = finalAnswer.indexOf(
		PULL_REQUEST_END,
		start + PULL_REQUEST_START.length,
	);
	if (start < 0 || end < 0) return null;
	const text = finalAnswer.slice(start + PULL_REQUEST_START.length, end).trim();
	if (text.length < 20 || isAutomaticDraftBoilerplate(text)) return null;
	return clip(text, 6000);
}

/**
 * Pull request description for this handoff. Prefers the agent's
 * `<pull-request>` text. Otherwise assembles what changed and what was run
 * from the turn. Never returns the automatic-draft sentence.
 */
export function pullRequestHandoffBody(input: {
	readonly description: string | null;
	readonly finalAnswer: string | null;
	readonly files: readonly string[];
	readonly verification: readonly HandoffVerification[];
}) {
	const files = uniquePaths(input.files);
	const verification = input.verification.slice(0, 8);
	const written = input.description?.trim() || null;
	if (written && !isAutomaticDraftBoilerplate(written))
		return withChangeNote(withUnmentionedFacts(written, files, verification));
	const summary = summaryFromFinalAnswer(input.finalAnswer);
	if (!summary && files.length === 0 && verification.length === 0)
		return PULL_REQUEST_DESCRIPTION_MISSING;
	const lines = [
		"## Summary",
		"",
		summary ??
			"The chat's branch changes the files below. This turn did not include a written description of why.",
	];
	appendFacts(lines, files, verification);
	return withChangeNote(lines.join("\n"));
}

/** Files from `git diff --name-only -z` (or a line-oriented listing). */
export function changedPathsFromDiff(stdout: string) {
	const parts = stdout.includes("\0") ? stdout.split("\0") : stdout.split("\n");
	return uniquePaths(parts);
}

/** The latest user request's written description, files, and checks. */
export function handoffFactsFromItems(
	items: readonly SessionItem[],
): PullRequestHandoffFacts {
	let start = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (
			item?.kind === "userMessage" &&
			item.text.trim() &&
			!item.text.startsWith("You are in a ytimesy workspace VM.")
		) {
			start = index + 1;
			break;
		}
	}
	let description: string | null = null;
	let finalAnswer: string | null = null;
	const files: string[] = [];
	const verification: HandoffVerification[] = [];
	for (const item of items.slice(start)) {
		if (item.kind === "agentMessage" && item.text.trim()) {
			finalAnswer = item.text;
			const written = agentPullRequestDescription(item.text);
			if (written) description = written;
		} else if (item.kind === "fileChange" && item.status !== "declined") {
			for (const change of item.changes) files.push(change.path);
		} else if (
			(item.kind === "commandExecution" && item.status === "completed") ||
			(item.kind === "commandExecution" && item.status === "failed")
		) {
			const command = displayCommand(item.command);
			if (command) verification.push({ command, exitCode: item.exitCode });
		}
	}
	return {
		description,
		finalAnswer,
		files: uniquePaths(files),
		verification: pickVerification(verification),
	};
}

/** Keeps a stored evidence section when the description is replaced. */
export function descriptionKeepingEvidence(
	current: string | null | undefined,
	description: string,
) {
	const evidence = evidenceSection(current);
	const text = description.trim();
	if (!evidence || text.includes(EVIDENCE_START)) return text;
	return `${text}\n\n${evidence}`;
}

/**
 * A follow-up handoff replaces the description, except a placeholder must not
 * wipe a description that already says what changed. Boilerplate is replaced.
 */
export function shouldReplacePullRequestBody(
	current: string | null | undefined,
	next: string,
) {
	const incoming = next.trim();
	if (!incoming) return false;
	if (!isPlaceholderDescription(incoming)) return true;
	const prose = stripKnownSections(current ?? "");
	if (!prose || isPlaceholderDescription(prose)) return true;
	return false;
}

function isPlaceholderDescription(text: string) {
	const prose = stripKnownSections(text);
	return (
		prose === PULL_REQUEST_DESCRIPTION_MISSING ||
		isAutomaticDraftBoilerplate(prose)
	);
}

function isAutomaticDraftBoilerplate(text: string) {
	return (
		/automatic draft handoff from ytimesy/i.test(text) &&
		text.trim().length < 400
	);
}

function evidenceSection(body: string | null | undefined) {
	const current = body ?? "";
	const start = current.indexOf(EVIDENCE_START);
	const end = current.indexOf(EVIDENCE_END, start);
	if (start < 0 || end < 0) return null;
	return current.slice(start, end + EVIDENCE_END.length);
}

function stripKnownSections(body: string) {
	return body
		.replace(
			/<!-- ytimesy-evidence:start[\s\S]*?<!-- ytimesy-evidence:end -->/g,
			"",
		)
		.replace(/<!-- ytimesy-fix:start -->[\s\S]*?<!-- ytimesy-fix:end -->/g, "")
		.trim();
}

function summaryFromFinalAnswer(text: string | null) {
	if (!text) return null;
	const stripped = text
		.replace(/<requirements>[\s\S]*?<\/requirements>/gi, "")
		.replace(/<pull-request>[\s\S]*?<\/pull-request>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
	if (stripped.length < 40 || isAutomaticDraftBoilerplate(stripped))
		return null;
	return clip(stripped, 1500);
}

function withUnmentionedFacts(
	description: string,
	files: readonly string[],
	verification: readonly HandoffVerification[],
) {
	const lines = [description.trim()];
	const filesMissing = files.every((file) => !description.includes(file));
	const checksMissing = verification.every(
		(step) => !description.includes(step.command),
	);
	appendFacts(
		lines,
		filesMissing ? files : [],
		checksMissing ? verification : [],
	);
	return lines.join("\n");
}

function appendFacts(
	lines: string[],
	files: readonly string[],
	verification: readonly HandoffVerification[],
) {
	if (files.length > 0) {
		lines.push(
			"",
			"## What changed",
			"",
			...files.map((file) => `- \`${file.replaceAll("`", "")}\``),
		);
	}
	if (verification.length > 0) {
		lines.push(
			"",
			"## Verification",
			"",
			...verification.map((step) => {
				const status = step.exitCode === null ? "ran" : `exit ${step.exitCode}`;
				return `- \`${step.command.replaceAll("`", "")}\` (${status})`;
			}),
		);
	}
}

function withChangeNote(body: string) {
	if (body.includes("@ytimesy")) return body.trim();
	return `${body.trim()}\n\n${CHANGE_NOTE}`;
}

function uniquePaths(paths: readonly string[]) {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		if (!isChangedPath(path) || seen.has(path.trim())) continue;
		seen.add(path.trim());
		result.push(path.trim());
		if (result.length >= 40) break;
	}
	return result;
}

function isChangedPath(path: string) {
	const value = path.trim();
	if (!value || value.length > 240) return false;
	if (value.startsWith("/") || value.includes("\\") || value.includes(".."))
		return false;
	if (/[\0\r\n]/.test(value) || /^\d+$/.test(value)) return false;
	return true;
}

function displayCommand(command: string) {
	if (SECRET_COMMAND.test(command)) return null;
	const one = command.replace(/\s+/g, " ").trim();
	if (!one) return null;
	return one.length > 180 ? `${one.slice(0, 177)}...` : one;
}

function pickVerification(entries: readonly HandoffVerification[]) {
	const checks = entries.filter((entry) => CHECK_COMMAND.test(entry.command));
	const chosen = checks.length
		? checks
		: entries.filter((entry) => !TRIVIAL_COMMAND.test(entry.command));
	return chosen.slice(-8);
}

function clip(text: string, max: number) {
	const clean = text.replace(/\r/g, "").trim();
	if (clean.length <= max) return clean;
	const slice = clean.slice(0, max);
	const breakAt = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "));
	const cut = breakAt > max * 0.6 ? slice.slice(0, breakAt + 1) : slice;
	return `${cut.trimEnd()}…`;
}
