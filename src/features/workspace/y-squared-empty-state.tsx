import {
	SUPER_AGENT_NAME,
	Y_SQUARED_EMPTY_TEXT,
	Y_SQUARED_SUGGESTIONS,
} from "#/domain/y-squared";
import { YSquaredMark } from "./y-squared-mark";

/** An empty Y² chat: what it is for, and questions that send at a click. */
export function YSquaredEmptyState({
	onSend,
	welcome,
}: {
	onSend: (text: string) => void;
	/** The chat's stored welcome message, when it is the chat's only item: shown as the block's text. */
	welcome?: string;
}) {
	return (
		<div className="y-squared-empty">
			<YSquaredMark size={40} live />
			<p className="y-squared-empty-text">{welcome ?? Y_SQUARED_EMPTY_TEXT}</p>
			<ul
				className="y-squared-suggestions"
				aria-label={`Ask ${SUPER_AGENT_NAME}`}
			>
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
