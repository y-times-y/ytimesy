import { Check, Eye, Minus, UserRound } from "lucide-react";
import type {
	PullRequestChecksCount,
	PullRequestReviewMark,
} from "#/domain/pull-request-review";
import { Avatar, displayName } from "./github-ui";

/** The chat working on a pull request, found by its branch. */
export type PullRequestChat = {
	readonly id: string;
	readonly title: string;
	/** ytimesy is running a turn in it now. */
	readonly working: boolean;
};

const BAR_MAX = 14;

/**
 * The chat beside a pull request: a thin rail and its name. The rail is quiet
 * while the chat is idle and sweeps blue while ytimesy works in it. It opens
 * the chat; it is not a badge.
 */
export function ChatRail({
	chat,
	onOpen,
}: {
	chat: PullRequestChat | undefined;
	onOpen?: (chatId: string) => void;
}) {
	if (!chat) return <span className="gh-mark-none">—</span>;
	return (
		<button
			type="button"
			className="gh-chat-rail"
			data-working={chat.working || undefined}
			title={chat.working ? `${chat.title}: ytimesy is working` : chat.title}
			onClick={() => onOpen?.(chat.id)}
		>
			<span className="gh-chat-rail-line" aria-hidden="true" />
			<span className="gh-chat-rail-name">{chat.title}</span>
			{chat.working ? <span className="sr-only"> (working)</span> : null}
		</button>
	);
}

/**
 * Who reviewed, shown as the person: their avatar with a small mark for what
 * they did (a check for an approval, a minus for a request for changes, an eye
 * for a review still asked for). A review asked of the signed-in user shows an
 * empty dashed avatar and the words "your review".
 */
export function ReviewMark({
	mark,
}: {
	mark: PullRequestReviewMark | null | undefined;
}) {
	if (!mark) return <span className="gh-mark-none">—</span>;
	if (mark.kind === "requested" && mark.you)
		return (
			<span className="gh-review-mark" data-kind="yours">
				<span className="gh-mark-av" data-empty="true">
					<UserRound size={12} aria-hidden="true" />
					<span className="gh-mark-badge" data-kind="requested">
						<Eye size={8} aria-hidden="true" />
					</span>
				</span>
				<span className="gh-review-word">your review</span>
			</span>
		);
	const person = mark.kind === "requested" ? mark.from : mark.by;
	const words =
		mark.kind === "approved"
			? "approved"
			: mark.kind === "changes"
				? "changes"
				: displayName(person);
	return (
		<span className="gh-review-mark" data-kind={mark.kind}>
			<span
				className="gh-mark-av"
				data-empty={mark.kind === "requested" || undefined}
				title={
					mark.kind === "approved"
						? `${displayName(person)} approved`
						: mark.kind === "changes"
							? `${displayName(person)} requested changes`
							: `Waiting for ${displayName(person)} to review`
				}
			>
				<Avatar person={person} size={22} />
				<span className="gh-mark-badge" data-kind={mark.kind}>
					{mark.kind === "approved" ? (
						<Check size={8} strokeWidth={3} aria-hidden="true" />
					) : mark.kind === "changes" ? (
						<Minus size={8} strokeWidth={3} aria-hidden="true" />
					) : (
						<Eye size={8} aria-hidden="true" />
					)}
				</span>
			</span>
			<span className="gh-review-word">{words}</span>
		</span>
	);
}

/** Check results as a row of small bars and a count, with failures said in words. */
export function ChecksCell({
	checks,
}: {
	checks: PullRequestChecksCount | null | undefined;
}) {
	if (!checks) return <span className="gh-mark-none">—</span>;
	const total = checks.passed + checks.failed + checks.pending;
	if (!total) return <span className="gh-mark-none">—</span>;
	const bars = Math.min(total, BAR_MAX);
	// Scale a long run down so the bar keeps its proportions.
	const scaled = (count: number) => Math.round((count / total) * bars);
	const passed = scaled(checks.passed);
	const failed = Math.min(
		scaled(checks.failed) || (checks.failed ? 1 : 0),
		bars - passed,
	);
	return (
		<span
			className="gh-checks-cell"
			title={`${checks.passed} passed, ${checks.failed} failing, ${checks.pending} running`}
		>
			<span className="gh-ckbar" aria-hidden="true">
				{Array.from({ length: bars }, (_, index) => (
					<i
						// biome-ignore lint/suspicious/noArrayIndexKey: bars have no identity
						key={index}
						data-state={
							index < passed
								? "passed"
								: index < passed + failed
									? "failed"
									: "running"
						}
					/>
				))}
			</span>
			<span className="gh-checks-count">
				{checks.passed}/{total}
			</span>
			{checks.failed ? (
				<span className="gh-checks-failing">{checks.failed} failing</span>
			) : null}
		</span>
	);
}
