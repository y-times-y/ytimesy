import { threadSuggestionsState } from "#/domain/thread-suggestions";
import { THREAD_SUGGESTIONS } from "#/domain/y-squared";
import { useSuggestionPref } from "./thread-suggestions-pref";

/**
 * A fresh thread: a friendly line and, for a new user's first project,
 * first things to ask. A returning user, or one who dismissed them, gets a
 * quiet "Show suggestions" link instead; the Super agent has its own.
 */
export function ThreadEmptyState({
	onSend,
	userId,
	projectCount,
	chatCount,
	superAgent = false,
}: {
	onSend: (text: string) => void;
	userId?: string;
	projectCount: number;
	/** Chats across all projects; null while the lists load. */
	chatCount: number | null;
	superAgent?: boolean;
}) {
	const { loading, pref, set } = useSuggestionPref(userId);
	const state =
		loading || chatCount === null
			? "loading"
			: threadSuggestionsState({ pref, projectCount, chatCount, superAgent });
	return (
		<ThreadEmptyView
			state={state}
			onSend={onSend}
			onDismiss={() => set("hide")}
			onShowAgain={() => set("show")}
		/>
	);
}

export function ThreadEmptyView({
	state,
	onSend,
	onDismiss,
	onShowAgain,
}: {
	state: "shown" | "offer" | "none" | "loading";
	onSend: (text: string) => void;
	onDismiss: () => void;
	onShowAgain: () => void;
}) {
	return (
		<div className="y-squared-empty thread-empty">
			<p className="y-squared-empty-text">
				Ready when you are. Ask anything about this project; setup keeps going
				in the background.
			</p>
			{state === "shown" ? (
				<>
					<ul
						className="y-squared-suggestions"
						aria-label="First things to ask"
					>
						{THREAD_SUGGESTIONS.map((text) => (
							<li key={text}>
								<button
									type="button"
									className="y-squared-suggestion"
									onClick={() => onSend(text)}
								>
									{text}
								</button>
							</li>
						))}
					</ul>
					<button
						type="button"
						className="thread-suggestions-link"
						onClick={onDismiss}
					>
						Don't show again
					</button>
				</>
			) : state === "offer" ? (
				<button
					type="button"
					className="thread-suggestions-link"
					onClick={onShowAgain}
				>
					Show suggestions
				</button>
			) : null}
		</div>
	);
}
