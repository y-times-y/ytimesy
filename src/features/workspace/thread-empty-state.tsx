import { showThreadSuggestions } from "#/domain/thread-suggestions";
import { THREAD_SUGGESTIONS } from "#/domain/y-squared";

/**
 * A fresh thread. A brand-new user's first project offers first things to
 * ask; everyone else (and the Super agent, and while the chat lists load)
 * gets just the composer: nothing is drawn.
 */
export function ThreadEmptyState({
	onSend,
	projectCount,
	chatCount,
	superAgent = false,
}: {
	onSend: (text: string) => void;
	projectCount: number;
	/** Chats across all projects; null while the lists load. */
	chatCount: number | null;
	superAgent?: boolean;
}) {
	if (
		chatCount === null ||
		!showThreadSuggestions({ projectCount, chatCount, superAgent })
	)
		return null;
	return (
		<div className="y-squared-empty thread-empty">
			<p className="y-squared-empty-text">
				Ready when you are. Ask anything about this project; setup keeps going
				in the background.
			</p>
			<ul className="y-squared-suggestions" aria-label="First things to ask">
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
		</div>
	);
}
