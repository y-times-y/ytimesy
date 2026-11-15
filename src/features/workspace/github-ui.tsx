import { useQuery } from "@tanstack/react-query";
import { Check, MoreHorizontal, Settings2 } from "lucide-react";
import { DropdownMenu, ScrollArea } from "radix-ui";
import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { labelTextColor } from "#/domain/github-issues";
import type {
	PullRequestLabel,
	PullRequestPerson,
	RepositoryChoices,
} from "#/domain/pull-request-review";
import { useAutoGrow } from "../app/use-auto-grow";
import { requestJson } from "../projects/api";
import { AgentMarkdown } from "../sessions/agent-markdown";

/**
 * One GitHub change from a button: whether it is running and the message it
 * failed with, shown beside the control that started it. Resolves true when
 * the change went through.
 */
export function useGithubAction<T>(change: (input: T) => Promise<unknown>) {
	const [pending, setPending] = useState(false);
	const inFlight = useRef(false);
	const [error, setError] = useState<string | null>(null);
	return {
		pending,
		error,
		clear: () => setError(null),
		run: async (input: T) => {
			if (inFlight.current) return false;
			inFlight.current = true;
			setPending(true);
			setError(null);
			try {
				await change(input);
				return true;
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
				return false;
			} finally {
				inFlight.current = false;
				setPending(false);
			}
		},
	};
}

/** The repository a GitHub panel works on, as the API routes take it. */
export type GithubRepositoryRef = {
	readonly installationId: number;
	readonly repositoryId: number;
};

export function Avatar({
	person,
	size = 20,
	className,
}: {
	person: PullRequestPerson;
	size?: number;
	className?: string;
}) {
	const classes = className ? `pr-avatar ${className}` : "pr-avatar";
	return person.avatarUrl ? (
		<img
			className={classes}
			src={`${person.avatarUrl}${person.avatarUrl.includes("?") ? "&" : "?"}s=${size * 2}`}
			alt=""
			width={size}
			height={size}
		/>
	) : (
		<span className={classes} style={{ width: size, height: size }} />
	);
}

export function displayName(person: PullRequestPerson) {
	return person.login.replace(/\[bot\]$/, "");
}

export function timeAgo(iso: string) {
	const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.round(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.round(months / 12)}y ago`;
}

export function Time({ iso, href }: { iso: string; href?: string | null }) {
	// Stable on the server and browser, including different time zones.
	const label = iso.slice(0, 10);
	const title = iso;
	return href ? (
		<a href={href} target="_blank" rel="noreferrer" title={title}>
			{label}
		</a>
	) : (
		<time dateTime={iso} title={title}>
			{label}
		</time>
	);
}

/** App-owned scroll rails in both directions, including on macOS and Windows. */
export function GithubScrollArea({
	children,
	className = "",
	...props
}: {
	children: ReactNode;
	className?: string;
	role?: string;
	"data-tab"?: string;
}) {
	return (
		<ScrollArea.Root
			className={`${className} gh-scroll`}
			type="auto"
			{...props}
		>
			<ScrollArea.Viewport className="gh-scroll-viewport">
				{children}
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar className="gh-scrollbar" orientation="vertical">
				<ScrollArea.Thumb className="gh-scroll-thumb" />
			</ScrollArea.Scrollbar>
			<ScrollArea.Scrollbar className="gh-scrollbar" orientation="horizontal">
				<ScrollArea.Thumb className="gh-scroll-thumb" />
			</ScrollArea.Scrollbar>
			<ScrollArea.Corner />
		</ScrollArea.Root>
	);
}

/** Long comments start folded so one bot summary doesn't bury the thread. */
export function Folded({ children }: { children: ReactNode }) {
	const body = useRef<HTMLDivElement>(null);
	const [tall, setTall] = useState(false);
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		if (body.current) setTall(body.current.scrollHeight > 340);
	}, []);
	return (
		<div className="pr-fold" data-folded={tall && !open}>
			<div ref={body} className="pr-comment-body">
				{children}
			</div>
			{tall ? (
				<button
					type="button"
					className="pr-fold-toggle"
					onClick={() => setOpen((value) => !value)}
				>
					{open ? "Show less" : "Show more"}
				</button>
			) : null}
		</div>
	);
}

export function Markdown({ text }: { text: string }) {
	return <AgentMarkdown text={text} fileMentions={false} />;
}

/**
 * A markdown box with Write and Preview, like GitHub's. ⌘/Ctrl+Enter runs the
 * primary action. The actions get the text and whether it is empty.
 */
export function MarkdownComposer({
	value,
	onChange,
	placeholder = "Leave a comment",
	label,
	autoFocus,
	minRows = 3,
	onSubmit,
	actions,
	toolbar,
	error,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	/** Read by screen readers; the placeholder stands in visually. */
	label: string;
	autoFocus?: boolean;
	minRows?: number;
	onSubmit?: () => void;
	actions: ReactNode;
	/** Extra buttons beside Write and Preview (Suggest change). */
	toolbar?: ReactNode;
	error?: string | null;
}) {
	const [mode, setMode] = useState<"write" | "preview">("write");
	const id = useId();
	const field = useRef<HTMLTextAreaElement>(null);
	useAutoGrow(field, value);
	return (
		<div className="gh-composer">
			<div className="gh-composer-tabs" role="tablist" aria-label={label}>
				<button
					type="button"
					role="tab"
					aria-selected={mode === "write"}
					onClick={() => setMode("write")}
				>
					Write
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === "preview"}
					onClick={() => setMode("preview")}
				>
					Preview
				</button>
				<span className="gh-composer-spacer" />
				{toolbar}
			</div>
			{mode === "write" ? (
				<textarea
					id={id}
					ref={field}
					aria-label={label}
					className="gh-composer-input"
					value={value}
					rows={minRows}
					placeholder={placeholder}
					// biome-ignore lint/a11y/noAutofocus: opening a reply or edit box is the request to type in it
					autoFocus={autoFocus}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							value.trim()
						) {
							event.preventDefault();
							onSubmit?.();
						}
					}}
				/>
			) : (
				<div className="gh-composer-preview pr-comment-body">
					{value.trim() ? (
						<Markdown text={value} />
					) : (
						<p className="pr-muted">Nothing to preview.</p>
					)}
				</div>
			)}
			{error ? (
				<p className="gh-error" role="alert">
					{error}
				</p>
			) : null}
			<div className="gh-composer-actions">{actions}</div>
		</div>
	);
}

/** A GitHub label in its own color. */
export function LabelChip({ label }: { label: PullRequestLabel }) {
	return (
		<span
			className="gh-label"
			title={label.description ?? undefined}
			style={{
				background: `#${label.color}`,
				color: labelTextColor(label.color),
			}}
		>
			{label.name}
		</span>
	);
}

/** Labels and assignable people of the repository, read when a picker first opens. */
export function useRepositoryChoices(
	api: "/api/github/pull-request" | "/api/github/issue",
	repository: GithubRepositoryRef,
	enabled: boolean,
) {
	return useQuery({
		queryKey: ["github-choices", repository.repositoryId],
		queryFn: () =>
			requestJson<RepositoryChoices>(
				`${api}?${new URLSearchParams({
					installationId: String(repository.installationId),
					repositoryId: String(repository.repositoryId),
					choices: "1",
				})}`,
			),
		enabled,
		staleTime: 5 * 60_000,
	});
}

/**
 * A sidebar field (Reviewers, Assignees, Labels): its current values and a
 * menu of checkable choices. Changes apply when the menu closes, as one call.
 */
export function ChoiceField<T>({
	title,
	empty,
	selected,
	options,
	loading,
	keyOf,
	renderValue,
	renderOption,
	onApply,
	busy,
	onOpen,
}: {
	title: string;
	empty: string;
	selected: readonly T[];
	options: readonly T[] | undefined;
	loading: boolean;
	keyOf: (item: T) => string;
	renderValue: (item: T) => ReactNode;
	renderOption: (item: T) => ReactNode;
	onApply: (next: T[]) => void;
	busy?: boolean;
	/** Called when the menu opens, to read the options. */
	onOpen?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<Map<string, T> | null>(null);
	const current = new Map(selected.map((item) => [keyOf(item), item]));
	const choices = [
		...selected,
		...(options ?? []).filter((item) => !current.has(keyOf(item))),
	];
	return (
		<div className="gh-field">
			<DropdownMenu.Root
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (next) {
						onOpen?.();
						setDraft(new Map(current));
					} else if (draft) {
						const changed =
							draft.size !== current.size ||
							[...draft.keys()].some((key) => !current.has(key));
						if (changed) onApply([...draft.values()]);
						setDraft(null);
					}
				}}
			>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="gh-field-head"
						disabled={busy}
						aria-label={`Edit ${title.toLowerCase()}`}
					>
						<span>{title}</span>
						<Settings2 size={13} aria-hidden="true" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						className="recovery-menu gh-choice-menu"
						sideOffset={6}
						align="start"
					>
						{loading && !options ? (
							<p className="gh-choice-note">Loading…</p>
						) : choices.length === 0 ? (
							<p className="gh-choice-note">Nothing to choose from.</p>
						) : (
							choices.map((item) => {
								const key = keyOf(item);
								const checked = draft?.has(key) ?? current.has(key);
								return (
									<DropdownMenu.CheckboxItem
										key={key}
										checked={checked}
										onSelect={(event) => event.preventDefault()}
										onCheckedChange={(value) =>
											setDraft((before) => {
												const next = new Map(before ?? current);
												if (value) next.set(key, item);
												else next.delete(key);
												return next;
											})
										}
									>
										<span className="menu-row-check">
											{checked ? <Check size={14} aria-hidden="true" /> : null}
										</span>
										{renderOption(item)}
									</DropdownMenu.CheckboxItem>
								);
							})
						)}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<div className="gh-field-values">
				{selected.length ? (
					selected.map((item) => (
						<span key={keyOf(item)}>{renderValue(item)}</span>
					))
				) : (
					<span className="pr-muted">{empty}</span>
				)}
			</div>
		</div>
	);
}

export function PersonOption({ person }: { person: PullRequestPerson }) {
	return (
		<span className="gh-person">
			<Avatar person={person} size={18} />
			{displayName(person)}
		</span>
	);
}

/** Edit and Delete for a comment the signed-in user wrote. */
export function OwnCommentMenu({
	onEdit,
	onDelete,
}: {
	onEdit: () => void;
	onDelete?: () => void;
}) {
	return (
		<DropdownMenu.Root>
			<DropdownMenu.Trigger asChild>
				<button
					type="button"
					className="pr-ghost gh-comment-menu"
					aria-label="Comment actions"
				>
					<MoreHorizontal size={14} />
				</button>
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					className="recovery-menu"
					sideOffset={4}
					align="end"
				>
					<DropdownMenu.Item onSelect={onEdit}>
						<span className="menu-row-label">Edit</span>
					</DropdownMenu.Item>
					{onDelete ? (
						<DropdownMenu.Item
							data-tone="bad"
							onSelect={() => {
								if (window.confirm("Delete this comment on GitHub?"))
									onDelete();
							}}
						>
							<span className="menu-row-label">Delete</span>
						</DropdownMenu.Item>
					) : null}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}

/**
 * A comment body that turns into an edit box in place. Saving calls onSave
 * and returns to reading when it resolves.
 */
export function EditableBody({
	text,
	editing,
	onCancel,
	onSave,
	saving,
	error,
	emptyText = "No description provided.",
}: {
	text: string;
	editing: boolean;
	onCancel: () => void;
	onSave: (next: string) => void;
	saving: boolean;
	error?: string | null;
	emptyText?: string;
}) {
	const [draft, setDraft] = useState(text);
	useLayoutEffect(() => {
		if (editing) setDraft(text);
	}, [editing, text]);
	if (editing)
		return (
			<MarkdownComposer
				label="Edit comment"
				value={draft}
				onChange={setDraft}
				autoFocus
				minRows={5}
				onSubmit={() => onSave(draft)}
				error={error}
				actions={
					<>
						<button type="button" className="pr-button" onClick={onCancel}>
							Cancel
						</button>
						<button
							type="button"
							className="pr-button"
							data-variant="primary"
							disabled={saving}
							onClick={() => onSave(draft)}
						>
							{saving ? "Saving…" : "Save"}
						</button>
					</>
				}
			/>
		);
	return text.trim() ? (
		<Folded>
			<Markdown text={text} />
		</Folded>
	) : (
		<p className="pr-muted">{emptyText}</p>
	);
}
