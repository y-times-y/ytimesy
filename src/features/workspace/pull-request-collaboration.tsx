import { useQuery } from "@tanstack/react-query";
import {
	ChevronRight,
	CircleCheck,
	CircleDashed,
	CircleX,
	ExternalLink,
	Lightbulb,
	RotateCcw,
	ScrollText,
} from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useState } from "react";
import {
	loginChanges,
	type PullRequestWriteAction,
	type ReviewEvent,
	type ReviewLineComment,
	suggestionBlock,
} from "#/domain/github-write";
import {
	groupReviewThreads,
	type PullRequestCheck,
	type PullRequestComment,
	type PullRequestDetail,
	type PullRequestPerson,
	type PullRequestThreadEntry,
	viewerWrote,
} from "#/domain/pull-request-review";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { requestJson } from "../projects/api";
import {
	HighlightedTokens,
	useHighlightedLines,
} from "../sessions/highlighted-code";
import type { DiffLineAddress, DiffLineComments } from "./diff-hunk-preview";
import {
	Avatar,
	ChoiceField,
	displayName,
	EditableBody,
	type GithubRepositoryRef,
	LabelChip,
	MarkdownComposer,
	OwnCommentMenu,
	PersonOption,
	Time,
	useGithubAction,
	useRepositoryChoices,
} from "./github-ui";

/** Sends one change to GitHub; the panel shows the pull request it returns. */
export type PullRequestWrite = (
	input: PullRequestWriteAction,
) => Promise<unknown>;

const reviewVerb: Record<string, string> = {
	APPROVED: "approved these changes",
	CHANGES_REQUESTED: "requested changes",
	DISMISSED: "had a review dismissed",
};

export function CheckIcon({ state }: { state: PullRequestCheck["state"] }) {
	if (state === "passed") return <CircleCheck size={14} data-tone="ok" />;
	if (state === "failed") return <CircleX size={14} data-tone="bad" />;
	return <CircleDashed size={14} data-tone="wait" />;
}

function Hunk({ entry }: { entry: PullRequestComment }) {
	const lines = (entry.diffHunk ?? "")
		.split("\n")
		.filter((line) => !line.startsWith("@@"))
		.slice(-6);
	const code = lines.map((line) => line.slice(1));
	const highlighted = useHighlightedLines(
		code.join("\n"),
		sourceLanguageFromPath(entry.path ?? ""),
	);
	return (
		<figure className="pr-hunk">
			<figcaption>
				<span>{entry.path}</span>
				{entry.line ? <span>Line {entry.line}</span> : null}
			</figcaption>
			<pre>
				{lines.map((line, index) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: hunk lines have no identity
						key={index}
						data-sign={
							line.startsWith("+")
								? "add"
								: line.startsWith("-")
									? "del"
									: undefined
						}
						data-target={index === lines.length - 1 || undefined}
					>
						<i>{line[0] === "+" || line[0] === "-" ? line[0] : " "}</i>
						<HighlightedTokens
							text={code[index] ?? ""}
							tokens={highlighted?.[index]}
						/>
						{"\n"}
					</span>
				))}
			</pre>
		</figure>
	);
}

function CommentFrame({
	author,
	verb,
	tone,
	createdAt,
	url,
	menu,
	children,
}: {
	author: PullRequestPerson;
	verb: string;
	tone?: "ok" | "bad";
	createdAt: string;
	url?: string | null;
	menu?: ReactNode;
	children?: ReactNode;
}) {
	return (
		<li className="pr-comment">
			<Avatar person={author} size={24} />
			<div className="pr-comment-main">
				<p className="pr-comment-head">
					<strong>{displayName(author)}</strong>
					{author.bot ? <span className="pr-bot">Bot</span> : null}
					<span data-tone={tone}>{verb}</span>
					<span aria-hidden>·</span>
					<Time iso={createdAt} href={url} />
					{menu ? <span className="gh-comment-menu-slot">{menu}</span> : null}
				</p>
				{children}
			</div>
		</li>
	);
}

/** A comment's text, editable and deletable in place when the viewer wrote it. */
function CommentBody({
	entry,
	viewer,
	write,
	children,
}: {
	entry: PullRequestComment;
	viewer: string | null | undefined;
	write: PullRequestWrite;
	children: (parts: { body: ReactNode; menu: ReactNode }) => ReactNode;
}) {
	const [editing, setEditing] = useState(false);
	const save = useGithubAction(write);
	const kind = entry.kind === "inline" ? "inline" : "comment";
	const editable =
		entry.kind !== "review" &&
		entry.databaseId !== undefined &&
		viewerWrote(entry, viewer);
	const commentId = entry.databaseId ?? 0;
	const menu = editable ? (
		<OwnCommentMenu
			onEdit={() => setEditing(true)}
			onDelete={() =>
				void save.run({ action: "delete-comment", kind, commentId })
			}
		/>
	) : null;
	return children({
		menu,
		body: (
			<>
				<EditableBody
					text={entry.body}
					editing={editing}
					saving={save.pending}
					error={save.error}
					emptyText=""
					onCancel={() => setEditing(false)}
					onSave={async (body) => {
						if (
							await save.run({ action: "edit-comment", kind, commentId, body })
						)
							setEditing(false);
					}}
				/>
				{!editing && save.error ? (
					<p className="gh-error" role="alert">
						{save.error}
					</p>
				) : null}
			</>
		),
	});
}

/** A reply box under a review thread. */
function ReplyBox({
	commentId,
	write,
	onDone,
}: {
	commentId: number;
	write: PullRequestWrite;
	onDone: () => void;
}) {
	const [text, setText] = useState("");
	const reply = useGithubAction(write);
	const send = async () => {
		if (await reply.run({ action: "reply", commentId, body: text })) {
			setText("");
			onDone();
		}
	};
	return (
		<MarkdownComposer
			label="Reply"
			placeholder="Reply…"
			value={text}
			onChange={setText}
			autoFocus
			minRows={2}
			onSubmit={send}
			error={reply.error}
			actions={
				<>
					<button type="button" className="pr-button" onClick={onDone}>
						Cancel
					</button>
					<button
						type="button"
						className="pr-button"
						data-variant="primary"
						disabled={!text.trim() || reply.pending}
						onClick={send}
					>
						{reply.pending ? "Replying…" : "Reply"}
					</button>
				</>
			}
		/>
	);
}

/**
 * A review thread on code: the first comment with its hunk, its replies, and
 * Reply and Resolve. A resolved thread starts folded, as on GitHub.
 */
export function ReviewThread({
	entry,
	viewer,
	write,
	showHunk = true,
}: {
	entry: PullRequestThreadEntry;
	viewer: string | null | undefined;
	write: PullRequestWrite;
	showHunk?: boolean;
}) {
	const resolved = entry.thread?.resolved ?? false;
	const [open, setOpen] = useState(!resolved);
	const [replying, setReplying] = useState(false);
	const resolve = useGithubAction(write);
	const thread = entry.thread;
	if (!open)
		return (
			<li className="gh-thread-folded">
				<button type="button" className="pr-link" onClick={() => setOpen(true)}>
					<ChevronRight size={13} aria-hidden="true" />
					Resolved conversation on <code>{entry.path}</code>
					{entry.replies.length
						? ` · ${entry.replies.length + 1} comments`
						: ""}
				</button>
			</li>
		);
	return (
		<CommentBody entry={entry} viewer={viewer} write={write}>
			{({ body, menu }) => (
				<CommentFrame
					author={entry.author}
					verb="commented on code"
					createdAt={entry.createdAt}
					url={entry.url}
					menu={menu}
				>
					{showHunk ? <Hunk entry={entry} /> : null}
					{body}
					{entry.replies.length ? (
						<ol className="gh-replies">
							{entry.replies.map((reply) => (
								<CommentBody
									key={reply.id}
									entry={reply}
									viewer={viewer}
									write={write}
								>
									{(parts) => (
										<CommentFrame
											author={reply.author}
											verb="replied"
											createdAt={reply.createdAt}
											url={reply.url}
											menu={parts.menu}
										>
											{parts.body}
										</CommentFrame>
									)}
								</CommentBody>
							))}
						</ol>
					) : null}
					{replying && entry.databaseId ? (
						<ReplyBox
							commentId={entry.databaseId}
							write={write}
							onDone={() => setReplying(false)}
						/>
					) : (
						<div className="gh-thread-actions">
							{entry.databaseId ? (
								<button
									type="button"
									className="pr-ghost"
									onClick={() => setReplying(true)}
								>
									Reply
								</button>
							) : null}
							{thread ? (
								<button
									type="button"
									className="pr-ghost"
									disabled={resolve.pending}
									onClick={async () => {
										if (
											(await resolve.run({
												action: "resolve-thread",
												threadId: thread.id,
												resolved: !thread.resolved,
											})) &&
											!thread.resolved
										)
											setOpen(false);
									}}
								>
									{resolve.pending
										? "Saving…"
										: thread.resolved
											? "Unresolve conversation"
											: "Resolve conversation"}
								</button>
							) : null}
							{resolve.error ? (
								<span className="gh-error" role="alert">
									{resolve.error}
								</span>
							) : null}
						</div>
					)}
				</CommentFrame>
			)}
		</CommentBody>
	);
}

/** The pull request's description, editable in place. */
function Description({
	pr,
	author,
	write,
}: {
	pr: PullRequestDetail;
	author: PullRequestPerson;
	write: PullRequestWrite;
}) {
	const [editing, setEditing] = useState(false);
	const save = useGithubAction(write);
	return (
		<CommentFrame
			author={author}
			verb="opened this pull request"
			createdAt={pr.createdAt}
			menu={
				<button
					type="button"
					className="pr-ghost gh-edit"
					onClick={() => setEditing(true)}
				>
					Edit
				</button>
			}
		>
			<EditableBody
				text={pr.body}
				editing={editing}
				saving={save.pending}
				error={save.error}
				onCancel={() => setEditing(false)}
				onSave={async (body) => {
					if (await save.run({ action: "edit", body })) setEditing(false);
				}}
			/>
		</CommentFrame>
	);
}

export function Conversation({
	pr,
	people,
	mergeBox,
	fields,
	write,
}: {
	pr: PullRequestDetail;
	people: Map<string, PullRequestPerson>;
	mergeBox: ReactNode;
	fields: ReactNode;
	write: PullRequestWrite;
}) {
	const author = people.get(pr.author) ?? {
		login: pr.author,
		avatarUrl: pr.authorAvatarUrl,
		bot: false,
	};
	const viewer = pr.viewer;
	// Approvals and change requests often have no text; they still belong in the thread.
	const verdicts = pr.reviews
		.filter((review) => reviewVerb[review.state] && review.submittedAt)
		.map((review) => ({
			id: `verdict:${review.author}:${review.submittedAt}`,
			author: people.get(review.author) ?? {
				login: review.author,
				avatarUrl: null,
				bot: review.author.endsWith("[bot]"),
			},
			state: review.state,
			createdAt: review.submittedAt ?? "",
		}));
	const timeline = [
		...groupReviewThreads(pr.conversation).map((entry) => ({
			at: entry.createdAt,
			node:
				entry.kind === "inline" ? (
					<ReviewThread
						key={entry.id}
						entry={entry}
						viewer={viewer}
						write={write}
					/>
				) : (
					<CommentBody
						key={entry.id}
						entry={entry}
						viewer={viewer}
						write={write}
					>
						{({ body, menu }) => (
							<CommentFrame
								author={entry.author}
								verb={entry.kind === "review" ? "reviewed" : "commented"}
								createdAt={entry.createdAt}
								url={entry.url}
								menu={menu}
							>
								{body}
							</CommentFrame>
						)}
					</CommentBody>
				),
		})),
		...verdicts.map((verdict) => ({
			at: verdict.createdAt,
			node: (
				<CommentFrame
					key={verdict.id}
					author={verdict.author}
					verb={reviewVerb[verdict.state] ?? "reviewed"}
					tone={verdict.state === "APPROVED" ? "ok" : "bad"}
					createdAt={verdict.createdAt}
				/>
			),
		})),
	].sort((a, b) => a.at.localeCompare(b.at));
	return (
		<div className="pr-thread">
			{fields}
			<ol>
				<Description pr={pr} author={author} write={write} />
				{timeline.map((item) => item.node)}
			</ol>
			{mergeBox}
			<CommentBox pr={pr} write={write} />
		</div>
	);
}

/** The comment box at the end of the conversation, with Close and Reopen. */
function CommentBox({
	pr,
	write,
}: {
	pr: PullRequestDetail;
	write: PullRequestWrite;
}) {
	const [text, setText] = useState("");
	const action = useGithubAction(
		async (input: "comment" | "close" | "reopen") => {
			if (text.trim()) {
				await write({ action: "comment", body: text });
				setText("");
			}
			if (input !== "comment")
				await write({
					action: "state",
					state: input === "close" ? "closed" : "open",
				});
			setText("");
		},
	);
	const closable = pr.state === "open" || pr.state === "draft";
	return (
		<section className="gh-comment-box" aria-label="Add a comment">
			<MarkdownComposer
				label="Add a comment"
				value={text}
				onChange={setText}
				onSubmit={() => void action.run("comment")}
				error={action.error}
				actions={
					<>
						{pr.state === "merged" ? null : (
							<button
								type="button"
								className="pr-button"
								disabled={action.pending}
								onClick={() => void action.run(closable ? "close" : "reopen")}
							>
								{closable
									? text.trim()
										? "Close with comment"
										: "Close pull request"
									: "Reopen pull request"}
							</button>
						)}
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={!text.trim() || action.pending}
							onClick={() => void action.run("comment")}
						>
							{action.pending ? "Sending…" : "Comment"}
						</button>
					</>
				}
			/>
		</section>
	);
}

/** Reviewers, Assignees and Labels, each editable from a menu. */
export function PullRequestFields({
	pr,
	repository,
	write,
}: {
	pr: PullRequestDetail;
	repository: GithubRepositoryRef;
	write: PullRequestWrite;
}) {
	const [wanted, setWanted] = useState(false);
	const choices = useRepositoryChoices(
		"/api/github/pull-request",
		repository,
		wanted,
	);
	const change = useGithubAction(write);
	const reviewers = pr.requestedReviewers ?? [];
	const assignees = pr.assignees ?? [];
	const labels = pr.labels ?? [];
	// GitHub refuses a review request to the pull request's own author.
	const reviewerOptions = choices.data?.people.filter(
		(person) => person.login !== pr.author,
	);
	const logins = (people: readonly PullRequestPerson[]) =>
		people.map((person) => person.login);
	return (
		<div className="gh-fields">
			<ChoiceField
				onOpen={() => setWanted(true)}
				title="Reviewers"
				empty="No reviewers"
				selected={reviewers}
				options={reviewerOptions}
				loading={choices.isFetching}
				busy={change.pending}
				keyOf={(person) => person.login}
				renderValue={(person) => <PersonOption person={person} />}
				renderOption={(person) => <PersonOption person={person} />}
				onApply={(next) =>
					void change.run({
						action: "reviewers",
						...loginChanges(logins(reviewers), logins(next)),
					})
				}
			/>
			<ChoiceField
				onOpen={() => setWanted(true)}
				title="Assignees"
				empty="No one"
				selected={assignees}
				options={choices.data?.people}
				loading={choices.isFetching}
				busy={change.pending}
				keyOf={(person) => person.login}
				renderValue={(person) => <PersonOption person={person} />}
				renderOption={(person) => <PersonOption person={person} />}
				onApply={(next) =>
					void change.run({
						action: "assignees",
						...loginChanges(logins(assignees), logins(next)),
					})
				}
			/>
			<ChoiceField
				onOpen={() => setWanted(true)}
				title="Labels"
				empty="None yet"
				selected={labels}
				options={choices.data?.labels}
				loading={choices.isFetching}
				busy={change.pending}
				keyOf={(label) => label.name}
				renderValue={(label) => <LabelChip label={label} />}
				renderOption={(label) => <LabelChip label={label} />}
				onApply={(next) =>
					void change.run({
						action: "labels",
						labels: next.map((label) => label.name),
					})
				}
			/>
			{change.error || choices.error ? (
				<p className="gh-error" role="alert">
					{change.error ?? choices.error?.message}
				</p>
			) : null}
		</div>
	);
}

const reviewChoices: { event: ReviewEvent; label: string; hint: string }[] = [
	{
		event: "COMMENT",
		label: "Comment",
		hint: "Submit general feedback without explicit approval.",
	},
	{
		event: "APPROVE",
		label: "Approve",
		hint: "Submit feedback and approve merging these changes.",
	},
	{
		event: "REQUEST_CHANGES",
		label: "Request changes",
		hint: "Submit feedback that must be addressed before merging.",
	},
];

/**
 * Review changes: a summary, a verdict, and the line comments gathered in
 * the Files tab, sent to GitHub as one review.
 */
export function ReviewSubmit({
	pr,
	pending,
	reviewHeadSha,
	onSubmitted,
	write,
}: {
	pr: PullRequestDetail;
	pending: readonly ReviewLineComment[];
	reviewHeadSha?: string;
	onSubmitted: () => void;
	write: PullRequestWrite;
}) {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [event, setEvent] = useState<ReviewEvent>("COMMENT");
	const submit = useGithubAction(write);
	// GitHub lets no one approve or request changes on their own pull request.
	const own =
		Boolean(pr.viewer) && pr.viewer?.toLowerCase() === pr.author.toLowerCase();
	const stale =
		pending.length > 0 &&
		reviewHeadSha !== undefined &&
		reviewHeadSha !== pr.headSha;
	const empty =
		event === "REQUEST_CHANGES"
			? !text.trim()
			: !text.trim() && event !== "APPROVE" && pending.length === 0;
	const send = async () => {
		if (empty || stale || submit.pending || (own && event !== "COMMENT"))
			return;
		if (
			await submit.run({
				action: "review",
				event,
				body: text,
				headSha: pr.headSha,
				comments: pending,
			})
		) {
			setText("");
			setOpen(false);
			onSubmitted();
		}
	};
	if (pr.state === "merged" || pr.state === "closed") return null;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button type="button" className="pr-button gh-review-trigger">
					Review changes
					{pending.length ? (
						<span className="gh-count">{pending.length}</span>
					) : null}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="gh-review-popover"
					sideOffset={6}
					align="end"
				>
					<h3>Finish your review</h3>
					{stale ? (
						<p className="gh-error" role="alert">
							New commits arrived while you were reviewing. Your pending
							comments are still here.{" "}
							<button type="button" className="pr-link" onClick={onSubmitted}>
								Discard pending comments and review the latest diff
							</button>
						</p>
					) : null}
					<MarkdownComposer
						label="Review summary"
						placeholder="Leave a summary (optional for an approval)"
						value={text}
						onChange={setText}
						autoFocus
						onSubmit={send}
						error={submit.error}
						actions={
							<button
								type="button"
								className="pr-button"
								data-variant="primary"
								disabled={empty || stale || submit.pending}
								onClick={send}
							>
								{submit.pending ? "Submitting…" : "Submit review"}
							</button>
						}
						toolbar={
							pending.length ? (
								<span className="pr-muted gh-pending-note">
									{pending.length} pending{" "}
									{pending.length === 1 ? "comment" : "comments"}
								</span>
							) : null
						}
					/>
					<fieldset className="gh-review-events">
						<legend className="sr-only">Review verdict</legend>
						{reviewChoices.map((choice) => {
							const disabled = own && choice.event !== "COMMENT";
							return (
								<label key={choice.event} data-disabled={disabled || undefined}>
									<input
										type="radio"
										name="review-event"
										value={choice.event}
										checked={event === choice.event}
										disabled={disabled}
										onChange={() => setEvent(choice.event)}
									/>
									<span>
										<strong>{choice.label}</strong>
										<small>
											{disabled
												? "Pull request authors can't do this on their own pull request."
												: choice.hint}
										</small>
									</span>
								</label>
							);
						})}
					</fieldset>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

const sameLine = (a: DiffLineAddress, b: DiffLineAddress) =>
	a.path === b.path && a.side === b.side && a.line === b.line;

/** A comment box opened on one diff line: comment now, or add it to the review. */
function LineCommentBox({
	address,
	lineText,
	pr,
	write,
	onPending,
	onClose,
}: {
	address: DiffLineAddress;
	lineText: string | null;
	pr: PullRequestDetail;
	write: PullRequestWrite;
	onPending: (comment: ReviewLineComment) => void;
	onClose: () => void;
}) {
	const [text, setText] = useState("");
	const post = useGithubAction(write);
	const single = async () => {
		if (
			await post.run({
				action: "line-comment",
				headSha: pr.headSha,
				...address,
				body: text,
			})
		)
			onClose();
	};
	return (
		<div className="gh-line-box">
			<MarkdownComposer
				label={`Comment on line ${address.line}`}
				value={text}
				onChange={setText}
				autoFocus
				onSubmit={single}
				error={post.error}
				toolbar={
					address.side === "RIGHT" && lineText !== null ? (
						<button
							type="button"
							className="pr-ghost"
							title="Suggest a change to this line"
							onClick={() =>
								setText(
									(before) =>
										`${before}${before.trim() ? "\n\n" : ""}${suggestionBlock(lineText)}`,
								)
							}
						>
							<Lightbulb size={13} aria-hidden="true" />
							Suggest change
						</button>
					) : null
				}
				actions={
					<>
						<button type="button" className="pr-button" onClick={onClose}>
							Cancel
						</button>
						<button
							type="button"
							className="pr-button"
							disabled={!text.trim() || post.pending}
							onClick={single}
						>
							{post.pending ? "Commenting…" : "Add single comment"}
						</button>
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={!text.trim() || post.pending}
							onClick={() => {
								onPending({ ...address, body: text });
								onClose();
							}}
						>
							Add to review
						</button>
					</>
				}
			/>
		</div>
	);
}

/** The text of a new-side line in the pull request's diff, for a suggestion. */
function lineTextAt(pr: PullRequestDetail, address: DiffLineAddress) {
	const preview = pr.files.find((file) => file.path === address.path)?.preview;
	if (!preview) return null;
	let line = 0;
	for (const row of preview.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
		if (hunk) {
			line = Number(hunk[1]);
			continue;
		}
		if (row.startsWith("+++") || row.startsWith("---")) continue;
		if (row.startsWith("-")) continue;
		if (!line || !(row.startsWith("+") || row.startsWith(" "))) continue;
		if (line === address.line) return row.slice(1);
		line += 1;
	}
	return null;
}

/**
 * Comments on the Files tab's lines: existing threads under their lines,
 * pending review comments, and the box a click on a line number opens.
 */
export function usePullRequestLineComments({
	pr,
	write,
	pending,
	onPendingChange,
}: {
	pr: PullRequestDetail | undefined;
	write: PullRequestWrite;
	pending: readonly ReviewLineComment[];
	onPendingChange: (next: ReviewLineComment[]) => void;
}): DiffLineComments | undefined {
	const [draftAt, setDraftAt] = useState<DiffLineAddress | null>(null);
	if (!pr || pr.state === "merged" || pr.state === "closed") return undefined;
	const threads = groupReviewThreads(pr.conversation).filter(
		(entry) => entry.kind === "inline" && entry.path && entry.line,
	);
	return {
		onLine: (address) => setDraftAt(address),
		widget: (address) => {
			const here = threads.filter(
				(entry) =>
					entry.path === address.path &&
					entry.line === address.line &&
					(entry.side ?? "RIGHT") === address.side,
			);
			const waiting = pending.filter((comment) => sameLine(comment, address));
			const drafting = draftAt && sameLine(draftAt, address);
			if (!here.length && !waiting.length && !drafting) return null;
			return (
				<div className="gh-line-widget">
					{here.length ? (
						<ol className="pr-thread-list">
							{here.map((entry) => (
								<ReviewThread
									key={entry.id}
									entry={entry}
									viewer={pr.viewer}
									write={write}
									showHunk={false}
								/>
							))}
						</ol>
					) : null}
					{waiting.map((comment) => (
						<div key={comment.body} className="gh-pending-comment">
							<span className="gh-pending-badge">Pending</span>
							<p>{comment.body}</p>
							<button
								type="button"
								className="pr-ghost"
								onClick={() =>
									onPendingChange(pending.filter((item) => item !== comment))
								}
							>
								Remove
							</button>
						</div>
					))}
					{drafting ? (
						<LineCommentBox
							address={address}
							lineText={lineTextAt(pr, address)}
							pr={pr}
							write={write}
							onPending={(comment) => onPendingChange([...pending, comment])}
							onClose={() => setDraftAt(null)}
						/>
					) : null}
				</div>
			);
		},
	};
}

/** One check's job log, read when opened. */
function CheckLog({
	repository,
	jobId,
}: {
	repository: GithubRepositoryRef;
	jobId: number;
}) {
	const log = useQuery({
		queryKey: ["github-job-log", repository.repositoryId, jobId],
		queryFn: () =>
			requestJson<{ log: string }>(
				`/api/github/pull-request?${new URLSearchParams({
					installationId: String(repository.installationId),
					repositoryId: String(repository.repositoryId),
					jobId: String(jobId),
				})}`,
			),
		staleTime: 60_000,
	});
	return log.error ? (
		<p className="gh-error" role="alert">
			{log.error.message}
		</p>
	) : (
		<pre className="gh-log" aria-busy={log.isPending || undefined}>
			{log.data?.log || (log.isPending ? "Loading log…" : "The log is empty.")}
		</pre>
	);
}

/** Checks with their logs and Re-run, so a red check is handled here. */
export function Checks({
	checks,
	repository,
	write,
}: {
	checks: readonly PullRequestCheck[];
	repository: GithubRepositoryRef;
	write: PullRequestWrite;
}) {
	const [logOpen, setLogOpen] = useState<number | null>(null);
	const rerun = useGithubAction(write);
	const [rerunning, setRerunning] = useState<string | null>(null);
	if (!checks.length)
		return <p className="pr-empty">No checks ran on this pull request.</p>;
	const failedRuns = [
		...new Set(
			checks
				.filter((check) => check.state === "failed" && check.job)
				.map((check) => check.job?.runId ?? 0),
		),
	];
	return (
		<div className="gh-checks">
			{failedRuns.length ? (
				<div className="gh-checks-bar">
					<button
						type="button"
						className="pr-button"
						disabled={rerun.pending}
						onClick={async () => {
							setRerunning("failed");
							for (const runId of failedRuns)
								if (
									!(await rerun.run({
										action: "rerun",
										target: { failedInRunId: runId },
									}))
								)
									break;
							setRerunning(null);
						}}
					>
						<RotateCcw size={13} aria-hidden="true" />
						{rerunning === "failed" ? "Re-running…" : "Re-run failed jobs"}
					</button>
				</div>
			) : null}
			{rerun.error ? (
				<p className="gh-error gh-checks-error" role="alert">
					{rerun.error}
				</p>
			) : null}
			<ul className="pr-checks">
				{checks.map((check) => {
					const job = check.job;
					const key = `${check.name}:${check.url ?? ""}`;
					return (
						<li key={key} data-open={job && logOpen === job.jobId}>
							<div className="gh-check-row">
								<CheckIcon state={check.state} />
								<span className="pr-check-name">{check.name}</span>
								<span className="pr-muted">
									{check.state === "passed"
										? "Passed"
										: check.state === "failed"
											? "Failed"
											: check.state === "skipped"
												? "Skipped"
												: "Running"}
								</span>
								{job ? (
									<button
										type="button"
										className="pr-ghost"
										aria-expanded={logOpen === job.jobId}
										aria-label={`Log of ${check.name}`}
										title="Log"
										onClick={() =>
											setLogOpen((open) =>
												open === job.jobId ? null : job.jobId,
											)
										}
									>
										<ScrollText size={14} />
									</button>
								) : null}
								{job && check.state !== "pending" ? (
									<button
										type="button"
										className="pr-ghost"
										aria-label={`Re-run ${check.name}`}
										title="Re-run"
										disabled={rerun.pending}
										onClick={async () => {
											setRerunning(key);
											await rerun.run({
												action: "rerun",
												target: { jobId: job.jobId },
											});
											setRerunning(null);
										}}
									>
										<RotateCcw size={14} data-spin={rerunning === key} />
									</button>
								) : null}
								{check.url ? (
									<a
										className="pr-ghost"
										href={check.url}
										target="_blank"
										rel="noreferrer"
										aria-label={`Open ${check.name}`}
									>
										<ExternalLink size={14} />
									</a>
								) : null}
							</div>
							{job && logOpen === job.jobId ? (
								<CheckLog repository={repository} jobId={job.jobId} />
							) : null}
						</li>
					);
				})}
			</ul>
		</div>
	);
}
