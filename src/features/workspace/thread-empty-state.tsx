import { THREAD_SUGGESTIONS } from "#/domain/y-squared";

/** A fresh thread: a friendly line and first things to ask, each sends at a click. */
export function ThreadEmptyState({
	onSend,
}: {
	onSend: (text: string) => void;
}) {
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
