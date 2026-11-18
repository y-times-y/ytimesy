import {
	CircleCheck,
	CircleDot,
	CircleX,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	type LucideIcon,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { chatAddress } from "#/domain/chat-address";
import type { ThreadDirectory } from "#/domain/thread-label";
import { ThreadArt } from "../workspace/thread-art";
import {
	type EventKind,
	type IssueReference,
	type PullRequestReference,
	threadReference,
} from "./agent-references";

/**
 * What the workspace tells the chips: the project's repository (a bare
 * `#12` is its), the open pull requests it lists, and its threads' labels.
 * Without it a chip still works and opens GitHub.
 */
export type ReferenceContextValue = {
	readonly defaultRepository?: string | null;
	/** Lowercase "owner/repo#12" keys of the project's pull requests. */
	readonly pullRequests?: ReadonlySet<string>;
	readonly threads?: ThreadDirectory;
};
export const ReferenceContext = createContext<ReferenceContextValue | null>(
	null,
);

/** Fired by a pull request or issue chip; a listener that opens it in the app sets `handled`. */
export const OPEN_REFERENCE_EVENT = "ytimesy:open-reference";
export type OpenReferenceDetail = {
	readonly kind: "pull-request" | "issue";
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	handled: boolean;
};

/** A pull request or issue chip opens in the app when the workspace takes it, else on GitHub. */
function openReferenceInApp(event: MouseEvent) {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey ||
		!(event.target instanceof Element)
	)
		return;
	const chip = event.target.closest(
		'a[data-reference="pull-request"], a[data-reference="issue"]',
	);
	const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(
		chip?.getAttribute("data-ref") ?? "",
	);
	if (!chip || !match) return;
	const detail: OpenReferenceDetail = {
		kind:
			chip.getAttribute("data-reference") === "issue"
				? "issue"
				: "pull-request",
		owner: match[1] ?? "",
		repo: match[2] ?? "",
		number: Number(match[3]),
		handled: false,
	};
	window.dispatchEvent(new CustomEvent(OPEN_REFERENCE_EVENT, { detail }));
	if (detail.handled) event.preventDefault();
}

/**
 * Opens a thread chip's chat on this page the way Back and Forward do: the
 * address names it and the workspace opens the chat the address names (its
 * popstate listener). One listener on the document serves every chip, the
 * ones React draws and those in a settled reply's server HTML alike. A
 * modified click keeps the link's own behaviour (a new tab).
 */
function openThreadInPlace(event: MouseEvent) {
	if (
		event.defaultPrevented ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey ||
		!(event.target instanceof Element)
	)
		return;
	const chip = event.target.closest('a[data-reference="thread"]');
	const id = threadReference(chip?.getAttribute("href") ?? undefined);
	if (!id) return;
	event.preventDefault();
	window.history.pushState(
		window.history.state,
		"",
		chatAddress(window.location, id),
	);
	window.dispatchEvent(
		new PopStateEvent("popstate", { state: window.history.state }),
	);
}

if (typeof document !== "undefined") {
	document.addEventListener("click", openThreadInPlace);
	document.addEventListener("click", openReferenceInApp);
}

/** A thread of this project, by its title and its short label; opens it. */
export function ThreadChip({
	id,
	title,
	label,
}: {
	id: string;
	title: ReactNode;
	/** "ytimesy-12": the thread's name in the project. */
	label?: string;
}) {
	return (
		<a
			className="reference-chip"
			data-reference="thread"
			href={`/thread/${id}`}
		>
			<ThreadArt id={id} size={16} />
			{label ? (
				<span className="reference-chip-id" data-thread-label>
					{label}
				</span>
			) : null}
			<span className="reference-chip-label">{title}</span>
		</a>
	);
}

/** `#123` when the number is the project's own repository's, else `repo#123`. */
function numberLabel(
	ref: { owner: string; repo: string; number: number },
	defaultRepository: string | null | undefined,
) {
	const own =
		defaultRepository?.toLowerCase() ===
		`${ref.owner}/${ref.repo}`.toLowerCase();
	return own ? `#${ref.number}` : `${ref.repo}#${ref.number}`;
}

/** The small secondary link on a chip: the same pull request or issue on GitHub. */
function GitHubLink({ url, name }: { url: string; name: string }) {
	return (
		<a
			className="reference-chip-github"
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			title="Open on GitHub"
			aria-label={`Open ${name} on GitHub`}
		>
			<ExternalLink aria-hidden size={11} strokeWidth={2} />
		</a>
	);
}

/**
 * A pull request as a chip: the PR icon and `#123` (or the reply's own
 * label). A click opens it in the app's pull request view when the workspace
 * knows the repository (OPEN_REFERENCE_EVENT), else on GitHub; the small
 * link after it always opens GitHub.
 */
export function PullRequestChip({
	pullRequest,
	label,
}: {
	pullRequest: PullRequestReference;
	label?: ReactNode;
}) {
	const context = useContext(ReferenceContext);
	const name = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
	return (
		<span className="reference-chip-group">
			<a
				className="reference-chip"
				data-reference="pull-request"
				data-ref={name}
				href={pullRequest.url}
				title={`${name} · open pull request`}
				target="_blank"
				rel="noopener noreferrer"
			>
				<GitPullRequest
					className="reference-chip-icon"
					aria-hidden
					size={13}
					strokeWidth={2}
				/>
				<span className="reference-chip-label">
					{label ?? numberLabel(pullRequest, context?.defaultRepository)}
				</span>
			</a>
			<GitHubLink url={pullRequest.url} name={name} />
		</span>
	);
}

/** An issue as a chip (issue icon, `#12`) that opens the Issues view, or GitHub when the repository is not the project's. */
export function IssueChip({
	issue,
	label,
}: {
	issue: IssueReference;
	label?: ReactNode;
}) {
	const context = useContext(ReferenceContext);
	const display = `${issue.owner}/${issue.repo}#${issue.number}`;
	return (
		<span className="reference-chip-group">
			<a
				className="reference-chip"
				data-reference="issue"
				data-ref={display}
				href={issue.url}
				title={`${display} · open issue`}
				target="_blank"
				rel="noopener noreferrer"
			>
				<CircleDot
					className="reference-chip-icon"
					aria-hidden
					size={13}
					strokeWidth={2}
				/>
				<span className="reference-chip-label">
					{label ?? numberLabel(issue, context?.defaultRepository)}
				</span>
			</a>
			<GitHubLink url={issue.url} name={display} />
		</span>
	);
}

const EVENT_ICONS: Record<EventKind, LucideIcon> = {
	finished: CircleCheck,
	"needs-you": CircleDot,
	merged: GitMerge,
	failed: CircleX,
};

/**
 * One quiet centered line for something that happened ("All 3 threads
 * finished"). It never wraps: text past the column ends in an ellipsis and
 * the title holds all of it.
 */
export function EventLine({
	kind,
	title,
	children,
}: {
	kind: EventKind;
	title?: string;
	children: ReactNode;
}) {
	const Icon = EVENT_ICONS[kind];
	return (
		<p className="session-event-line" data-event={kind} title={title}>
			<Icon
				className="session-event-icon"
				aria-hidden
				size={13}
				strokeWidth={2.25}
			/>
			<span className="session-event-text">{children}</span>
		</p>
	);
}

/**
 * A paragraph about one thread's status ("Fix sign-up form needs you:
 * merge web#8"), left-aligned prose with a small status icon in front.
 */
export function StatusParagraph({
	kind,
	children,
}: {
	kind: EventKind;
	children: ReactNode;
}) {
	const Icon = EVENT_ICONS[kind];
	return (
		<p className="session-status-paragraph" data-event={kind}>
			<Icon
				className="session-event-icon session-status-icon"
				aria-hidden
				size={13}
				strokeWidth={2.25}
			/>
			{children}
		</p>
	);
}
