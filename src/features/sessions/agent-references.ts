/**
 * Live references in Y and Y² replies, drawn as chips and event lines.
 *
 * - A thread: `[Fix sign-up form](thread:<chat id>)` (or `/thread/<chat id>`).
 * - A pull request: its GitHub URL, or `pr:owner/repo#123` in prose or as a link.
 * - An issue: its GitHub URL or `issue:owner/repo#12`. A bare `#12` is neither:
 *   its type is looked up (agent-reference-chips.tsx).
 * - An event: a line of its own, `::finished All 3 threads finished`
 *   (kinds below; `::event{kind="finished"} …` reads the same). One short
 *   centered line; a longer one reads as a status paragraph instead.
 * - A status paragraph: prose that starts with `:needs-you:` (or another
 *   kind), drawn left-aligned with a small status icon before its text.
 */

import {
	type ThreadDirectory,
	threadLabelSegments,
} from "#/domain/thread-label";

const CHAT_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const THREAD_SCHEME = "thread";
export const PULL_REQUEST_SCHEME = "pr";

/** The chat a thread link names; null for any other link or a malformed id. */
export function threadReference(href: string | undefined): string | null {
	const id = /^(?:thread:|\/thread\/)([^/?#\s]+)\/?$/i.exec(href ?? "")?.[1];
	return id && CHAT_ID.test(id) ? id.toLowerCase() : null;
}

export type PullRequestReference = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly url: string;
};

const NAME = "[A-Za-z0-9_.-]+";
const GITHUB_PULL = new RegExp(
	`^https://github\\.com/(${NAME})/(${NAME})/pull/(\\d+)(?:[/?#].*)?$`,
	"i",
);
const PULL_SHORTHAND = new RegExp(`^pr:(${NAME})/(${NAME})#(\\d+)$`, "i");
/** `pr:owner/repo#123` inside prose. */
const PULL_SHORTHAND_IN_TEXT = new RegExp(
	`(?<![\\w/])pr:(${NAME})/(${NAME})#(\\d+)\\b`,
	"gi",
);

function pullRequest(owner: string, repo: string, number: string) {
	return {
		owner,
		repo,
		number: Number(number),
		url: `https://github.com/${owner}/${repo}/pull/${Number(number)}`,
	};
}

/** The pull request a GitHub pull request URL or a `pr:owner/repo#123` names. */
export function pullRequestReference(
	href: string | undefined,
): PullRequestReference | null {
	const match = GITHUB_PULL.exec(href ?? "") ?? PULL_SHORTHAND.exec(href ?? "");
	if (!match) return null;
	const [, owner = "", repo = "", number = ""] = match;
	return pullRequest(owner, repo, number);
}

export type PullRequestSegment =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "pullRequest";
			readonly pullRequest: PullRequestReference;
	  };

/** Prose split around its `pr:owner/repo#123` references. */
export function pullRequestSegments(text: string): PullRequestSegment[] {
	const segments: PullRequestSegment[] = [];
	let last = 0;
	for (const match of text.matchAll(PULL_SHORTHAND_IN_TEXT)) {
		const [whole, owner = "", repo = "", number = ""] = match;
		if (match.index > last)
			segments.push({ kind: "text", text: text.slice(last, match.index) });
		segments.push({
			kind: "pullRequest",
			pullRequest: pullRequest(owner, repo, number),
		});
		last = match.index + whole.length;
	}
	if (last < text.length)
		segments.push({ kind: "text", text: text.slice(last) });
	return segments;
}

export const EVENT_KINDS = [
	"finished",
	"needs-you",
	"merged",
	"failed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
	return EVENT_KINDS.includes(value as EventKind);
}

const EVENT_MARKER = new RegExp(
	`^::(?:(${EVENT_KINDS.join("|")})(?=\\s|$)|event\\{\\s*kind\\s*=\\s*["']?(${EVENT_KINDS.join("|")})["']?\\s*\\})[ \\t]*`,
);

/** The event a paragraph's text starts with, and the marker's length; null for prose. */
export function eventMarker(
	text: string,
): { readonly kind: EventKind; readonly length: number } | null {
	const match = EVENT_MARKER.exec(text);
	if (!match) return null;
	return {
		kind: (match[1] ?? match[2]) as EventKind,
		length: match[0].length,
	};
}

/**
 * The longest event text drawn as a centered line; it fits one line of the
 * narrowest chat column. Longer text is a status paragraph.
 */
export const EVENT_LINE_MAX_LENGTH = 60;

/** Whether an event's text (without its marker) fits one centered line. */
export function fitsEventLine(text: string): boolean {
	return text.replace(/\s+/g, " ").trim().length <= EVENT_LINE_MAX_LENGTH;
}

const STATUS_MARKER = new RegExp(`^:(${EVENT_KINDS.join("|")}):[ \\t]*`);

/** The status a paragraph's text starts with (`:needs-you: …`), and the marker's length. */
export function statusMarker(
	text: string,
): { readonly kind: EventKind; readonly length: number } | null {
	const match = STATUS_MARKER.exec(text);
	if (!match) return null;
	return { kind: match[1] as EventKind, length: match[0].length };
}

/**
 * Event lines and status paragraphs as paragraphs of their own: a blank
 * line before and after each, so a line under prose does not join its
 * paragraph. Lines in code fences and indented lines (lists, quotes,
 * code) stay as they are.
 */
export function withEventLinesAsParagraphs(markdown: string): string {
	if (!markdown.includes(":")) return markdown;
	const out: string[] = [];
	let fence: string | null = null;
	let afterEvent = false;
	for (const line of markdown.split("\n")) {
		const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (opener && !fence) fence = opener;
		else if (
			opener &&
			opener[0] === fence?.[0] &&
			opener.length >= fence.length
		)
			fence = null;
		const event =
			!fence &&
			!opener &&
			(eventMarker(line) !== null || statusMarker(line) !== null);
		const blankBefore = event || afterEvent;
		if (blankBefore && line !== "" && out.length && out.at(-1) !== "")
			out.push("");
		out.push(line);
		afterEvent = event;
	}
	return out.join("\n");
}

export const ISSUE_SCHEME = "issue";

export type IssueReference = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** The issue's GitHub URL (GitHub redirects it to the pull request when the number is one). */
	readonly url: string;
};

const GITHUB_ISSUE = new RegExp(
	`^https://github\\.com/(${NAME})/(${NAME})/issues/(\\d+)(?:[/?#].*)?$`,
	"i",
);
const ISSUE_SHORTHAND = new RegExp(`^issue:(${NAME})/(${NAME})#(\\d+)$`, "i");

/** The issue a GitHub issue URL or an `issue:owner/repo#12` names. */
export function issueReference(
	href: string | undefined,
): IssueReference | null {
	const match =
		GITHUB_ISSUE.exec(href ?? "") ?? ISSUE_SHORTHAND.exec(href ?? "");
	if (!match) return null;
	const [, owner = "", repo = "", number = ""] = match;
	return issue(owner, repo, number);
}

function issue(owner: string, repo: string, number: string): IssueReference {
	return {
		owner,
		repo,
		number: Number(number),
		url: `https://github.com/${owner}/${repo}/issues/${Number(number)}`,
	};
}

/**
 * A bare `#12` or `owner/repo#12` in prose: GitHub numbers issues and pull
 * requests together, so its type is not known from the text. It links as
 * `ref:owner/repo#12` and the chip looks the type up.
 */
export const NUMBER_SCHEME = "ref";
const NUMBER_SHORTHAND = new RegExp(`^ref:(${NAME})/(${NAME})#(\\d+)$`, "i");

/** The pull request or issue a `ref:owner/repo#12` link names (type unknown). */
export function numberReference(
	href: string | undefined,
): IssueReference | null {
	const match = NUMBER_SHORTHAND.exec(href ?? "");
	if (!match) return null;
	const [, owner = "", repo = "", number = ""] = match;
	return issue(owner, repo, number);
}

/** `#12` or `owner/repo#12` in prose; a bare number needs the project's repository. */
const NUMBER_IN_TEXT = new RegExp(
	`(?<![\\w/&#.-])(?:(${NAME})/(${NAME}))?#(\\d+)(?![\\w-])`,
	"g",
);

/** The lowercase key a reference is looked up by: "owner/repo#12". */
export function referenceKey(ref: {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
}) {
	return `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}

export type ReferenceSegment =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "pullRequest"; readonly pullRequest: PullRequestReference }
	| { readonly kind: "issue"; readonly issue: IssueReference }
	/** A bare number: an issue or a pull request, not yet known. */
	| { readonly kind: "number"; readonly number: IssueReference }
	| { readonly kind: "thread"; readonly label: string; readonly id: string };

/**
 * Prose split around everything that links: `pr:owner/repo#1`,
 * `owner/repo#12`, a bare `#12` (with `defaultRepository` "owner/repo")
 * and a known thread's label. A bare number is neither issue nor pull
 * request here (kind "number"); the chip resolves its type.
 */
export function referenceSegments(
	text: string,
	options: {
		readonly defaultRepository?: string | null;
		readonly threads?: ThreadDirectory;
	} = {},
): ReferenceSegment[] {
	const [defaultOwner, defaultRepo] = (options.defaultRepository ?? "").split(
		"/",
	);
	const out: ReferenceSegment[] = [];
	for (const segment of pullRequestSegments(text)) {
		if (segment.kind !== "text") {
			out.push(segment);
			continue;
		}
		let last = 0;
		const pushText = (end: number) => {
			if (end > last)
				out.push(
					...labelSegments(segment.text.slice(last, end), options.threads),
				);
		};
		for (const match of segment.text.matchAll(NUMBER_IN_TEXT)) {
			const owner = match[1] ?? defaultOwner;
			const repo = match[2] ?? defaultRepo;
			if (!owner || !repo) continue;
			pushText(match.index);
			out.push({ kind: "number", number: issue(owner, repo, match[3] ?? "") });
			last = match.index + match[0].length;
		}
		pushText(segment.text.length);
	}
	return out;
}

function labelSegments(
	text: string,
	threads?: ThreadDirectory,
): ReferenceSegment[] {
	return threads?.size
		? threadLabelSegments(text, threads)
		: [{ kind: "text", text }];
}
