import {
	CircleCheck,
	CircleDot,
	CircleX,
	GitMerge,
	GitPullRequest,
	type LucideIcon,
	MessageSquare,
} from "lucide-react";
import type { ReactNode } from "react";
import { chatAddress } from "#/domain/chat-address";
import {
	type EventKind,
	type PullRequestReference,
	threadReference,
} from "./agent-references";

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

if (typeof document !== "undefined")
	document.addEventListener("click", openThreadInPlace);

/** A thread of this project, by its title; opens it. */
export function ThreadChip({ id, title }: { id: string; title: ReactNode }) {
	return (
		<a
			className="reference-chip"
			data-reference="thread"
			href={`/thread/${id}`}
		>
			<MessageSquare
				className="reference-chip-icon"
				aria-hidden
				size={13}
				strokeWidth={2}
			/>
			<span className="reference-chip-label">{title}</span>
		</a>
	);
}

/** A pull request as `repo#123` (or the reply's own label); opens it on GitHub. */
export function PullRequestChip({
	pullRequest,
	label,
}: {
	pullRequest: PullRequestReference;
	label?: ReactNode;
}) {
	const name = `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`;
	return (
		<a
			className="reference-chip"
			data-reference="pull-request"
			href={pullRequest.url}
			title={name}
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
				{label ?? `${pullRequest.repo}#${pullRequest.number}`}
			</span>
		</a>
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
