import {
	Y_SQUARED_EMPTY_TEXT,
	Y_SQUARED_SUGGESTIONS,
} from "#/domain/y-squared";
import { YSquaredMark } from "./y-squared-mark";

/** An empty Y² chat: what it is for, and questions that send at a click. */
export function YSquaredEmptyState({
	onSend,
}: {
	onSend: (text: string) => void;
}) {
	return (
		<div className="y-squared-empty">
			<YSquaredMark size={40} />
			<p className="y-squared-empty-text">{Y_SQUARED_EMPTY_TEXT}</p>
			<ul className="y-squared-suggestions" aria-label="Ask Y²">
				{Y_SQUARED_SUGGESTIONS.map((text) => (
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
