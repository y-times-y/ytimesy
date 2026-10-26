/** Lines the placeholder draws: more than any viewport shows. */
const PLACEHOLDER_LINES = 160;

/**
 * The code editor before CodeMirror mounts (server render, hydration, or its
 * chunk still loading): the same box, gutter and line metrics as the editor
 * (styles.css, `.source-editor-placeholder`), so the text does not move when
 * CodeMirror replaces it.
 */
export function SourceEditorPlaceholder({ value }: { value: string }) {
	const lines = value.split("\n");
	const shown = lines.slice(0, PLACEHOLDER_LINES);
	// CodeMirror sizes the line-number gutter for the last line's number.
	const digits = String(lines.length).length;
	return (
		<div className="source-editor source-editor-placeholder" aria-busy="true">
			<div
				className="source-editor-placeholder-scroller"
				style={{ ["--gutter-digits" as string]: digits }}
			>
				<div className="source-editor-placeholder-gutter" aria-hidden="true">
					<div>
						{shown.map((_, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: line numbers are the identity.
							<div key={index}>{index + 1}</div>
						))}
					</div>
					<div />
				</div>
				<div className="source-editor-placeholder-content">
					{shown.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static lines, never reordered.
						<div key={index}>{line || "​"}</div>
					))}
				</div>
			</div>
		</div>
	);
}
