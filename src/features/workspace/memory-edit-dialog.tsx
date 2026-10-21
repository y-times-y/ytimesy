import { X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Switch } from "#/components/ui/switch";
import { DEFAULT_TOPIC, MEMORY_EDIT_TEXT_MAX } from "#/domain/memory-edit";

export type MemoryDraft = {
	text: string;
	/** null: Personal. */
	project: string | null;
	always: boolean;
	topic: string;
};

/**
 * Add or edit one memory in plain words: what to remember, where it applies
 * (Personal or a project), and whether it is an always-on rule. A new line
 * also picks its topic file.
 */
export function MemoryEditDialog({
	mode,
	initial,
	projects,
	topics,
	pending,
	error,
	onSave,
	onClose,
}: {
	mode: "add" | "edit";
	initial: MemoryDraft;
	/** Project names (`project:` values) with a display label. */
	projects: readonly { value: string; label: string }[];
	/** Topic files a new line may go to, with titles. */
	topics: readonly { path: string; title: string }[];
	pending?: boolean;
	error?: string;
	onSave: (draft: MemoryDraft) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState(initial);
	const id = useId();
	const text = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		text.current?.focus();
		const close = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", close);
		return () => window.removeEventListener("keydown", close);
	}, [onClose]);
	const topicChoices = topics.some((topic) => topic.path === DEFAULT_TOPIC)
		? topics
		: [...topics, { path: DEFAULT_TOPIC, title: "Notes (new topic)" }];
	const changed =
		draft.text.trim() !== initial.text.trim() ||
		draft.project !== initial.project ||
		draft.always !== initial.always ||
		draft.topic !== initial.topic;
	return createPortal(
		<div
			className="memory-dialog-backdrop"
			onPointerDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<form
				className="memory-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby={`${id}-title`}
				onSubmit={(event) => {
					event.preventDefault();
					if (draft.text.trim() && changed && !pending) onSave(draft);
				}}
			>
				<header>
					<h2 id={`${id}-title`}>
						{mode === "add" ? "Add a memory" : "Edit memory"}
					</h2>
					<button
						type="button"
						className="memory-icon-button"
						aria-label="Close"
						onClick={onClose}
					>
						<X size={14} />
					</button>
				</header>
				<label className="memory-field">
					<span>What should the agent remember?</span>
					<textarea
						ref={text}
						rows={3}
						maxLength={MEMORY_EDIT_TEXT_MAX}
						placeholder="For example: Use pnpm, never npm."
						value={draft.text}
						onChange={(event) =>
							setDraft({ ...draft, text: event.target.value })
						}
						onKeyDown={(event) => {
							if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
								event.currentTarget.form?.requestSubmit();
						}}
					/>
				</label>
				<div className="memory-field-row">
					<label className="memory-field">
						<span>Applies to</span>
						<select
							value={draft.project ?? ""}
							onChange={(event) =>
								setDraft({ ...draft, project: event.target.value || null })
							}
						>
							<option value="">Personal: every project</option>
							{projects.map((project) => (
								<option key={project.value} value={project.value}>
									{project.label}
								</option>
							))}
						</select>
					</label>
					{mode === "add" ? (
						<label className="memory-field">
							<span>Topic</span>
							<select
								value={draft.topic}
								onChange={(event) =>
									setDraft({ ...draft, topic: event.target.value })
								}
							>
								{topicChoices.map((topic) => (
									<option key={topic.path} value={topic.path}>
										{topic.title}
									</option>
								))}
							</select>
						</label>
					) : null}
				</div>
				<div className="memory-switch-row">
					<div>
						<label htmlFor={`${id}-always`}>Always-on rule</label>
						<p>
							Attach it to every chat in{" "}
							{draft.project ? "this project" : "every project"}, whatever the
							request, instead of only when it looks relevant.
						</p>
					</div>
					<Switch
						id={`${id}-always`}
						checked={draft.always}
						onCheckedChange={(always) => setDraft({ ...draft, always })}
					/>
				</div>
				{error ? (
					<p className="memory-dialog-error" role="alert">
						{error}
					</p>
				) : null}
				<footer>
					<button type="button" onClick={onClose}>
						Cancel
					</button>
					<button
						type="submit"
						className="memory-primary"
						disabled={!draft.text.trim() || !changed || pending}
					>
						{pending ? "Saving…" : mode === "add" ? "Add memory" : "Save"}
					</button>
				</footer>
			</form>
		</div>,
		document.body,
	);
}
