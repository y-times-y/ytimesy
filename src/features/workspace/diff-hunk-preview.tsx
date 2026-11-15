import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import {
	type ChangeData,
	Diff,
	getChangeKey,
	Hunk,
	type HunkData,
	type HunkTokens,
} from "react-diff-view";
import type { DiffPreviewHunk } from "#/domain/diff-preview";
import type { SourceLanguage } from "#/domain/source-language";
import {
	HighlightedTokens,
	useHighlightedLines,
} from "../sessions/highlighted-code";

function diffViewHunk(preview: DiffPreviewHunk): HunkData {
	const changes = preview.lines.map((line): ChangeData => {
		if (line.oldNumber === null)
			return {
				type: "insert",
				isInsert: true,
				lineNumber: line.newNumber ?? 0,
				content: line.text,
			};
		if (line.newNumber === null)
			return {
				type: "delete",
				isDelete: true,
				lineNumber: line.oldNumber,
				content: line.text,
			};
		return {
			type: "normal",
			isNormal: true,
			oldLineNumber: line.oldNumber,
			newLineNumber: line.newNumber,
			content: line.text,
		};
	});
	const oldLines = changes.filter((line) => line.type !== "insert").length;
	const newLines = changes.filter((line) => line.type !== "delete").length;
	return {
		oldStart: preview.oldStart,
		newStart: preview.newStart,
		oldLines,
		newLines,
		changes,
		content: `@@ -${preview.oldStart},${oldLines} +${preview.newStart},${newLines} @@`,
	};
}

/** A diff line as GitHub addresses it for review comments. */
export type DiffLineAddress = {
	readonly path: string;
	readonly side: "LEFT" | "RIGHT";
	readonly line: number;
};

/**
 * Comments on diff lines (a pull request review): what shows under a line,
 * and what clicking a line's number starts.
 */
export type DiffLineComments = {
	readonly widget: (address: DiffLineAddress) => ReactNode;
	readonly onLine: (address: DiffLineAddress) => void;
};

function lineAddress(path: string, change: ChangeData): DiffLineAddress {
	if (change.type === "delete")
		return { path, side: "LEFT", line: change.lineNumber };
	return {
		path,
		side: "RIGHT",
		line: change.type === "normal" ? change.newLineNumber : change.lineNumber,
	};
}

export function DiffHunkPreview({
	preview,
	language,
	path,
	lineComments,
}: {
	preview: DiffPreviewHunk;
	language: SourceLanguage;
	/** The file, needed only with lineComments. */
	path?: string;
	lineComments?: DiffLineComments;
}) {
	const hunk = diffViewHunk(preview);
	const widgets: Record<string, ReactNode> = {};
	if (lineComments && path)
		for (const change of hunk.changes) {
			const widget = lineComments.widget(lineAddress(path, change));
			if (widget) widgets[getChangeKey(change)] = widget;
		}
	const oldLines = preview.lines.filter((line) => line.oldNumber !== null);
	const newLines = preview.lines.filter((line) => line.newNumber !== null);
	const oldHighlight = useHighlightedLines(
		oldLines.map((line) => line.text).join("\n"),
		language,
	);
	const newHighlight = useHighlightedLines(
		newLines.map((line) => line.text).join("\n"),
		language,
	);
	const tokens: HunkTokens = { old: [], new: [] };
	oldLines.forEach((line, index) => {
		tokens.old[(line.oldNumber ?? 1) - 1] = [
			{ type: "shiki", value: line.text, highlighted: oldHighlight?.[index] },
		];
	});
	newLines.forEach((line, index) => {
		tokens.new[(line.newNumber ?? 1) - 1] = [
			{ type: "shiki", value: line.text, highlighted: newHighlight?.[index] },
		];
	});
	return (
		<Diff
			viewType="unified"
			diffType="modify"
			hunks={[hunk]}
			tokens={tokens}
			widgets={widgets}
			className={lineComments ? "diff-commentable" : undefined}
			renderGutter={({ change, side, inHoverState, renderDefault }) => {
				const activeSide = change.type === "delete" ? "old" : "new";
				if (!lineComments || !path || side !== activeSide)
					return renderDefault();
				const address = lineAddress(path, change);
				return (
					<button
						type="button"
						className="diff-line-comment"
						aria-label={`Comment on ${address.side === "LEFT" ? "old" : "new"} line ${address.line} of ${path}`}
						onClick={() => lineComments.onLine(address)}
					>
						{inHoverState ? (
							<span className="diff-line-add">
								<Plus size={12} aria-hidden="true" />
							</span>
						) : (
							renderDefault()
						)}
					</button>
				);
			}}
			renderToken={(token, renderDefault, index) =>
				token.type === "shiki" ? (
					<HighlightedTokens
						key={index}
						text={token.value}
						tokens={token.highlighted}
					/>
				) : (
					renderDefault(token, index)
				)
			}
		>
			{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
		</Diff>
	);
}
