import type { ReactNode } from "react";
import { fileBasename } from "#/domain/file-kind";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { type ToolDetailView, toolDetailView } from "#/domain/tool-detail-view";
import { FileTypeIcon } from "./file-type-icon";
import { HighlightedTokens, useHighlightedLines } from "./highlighted-code";
import { ShellCommandCode } from "./shell-command-code";
import { ToolInputFields } from "./tool-cards";

/** An opened tool card: one panel that shows the call as it happened. */
export function ToolDetailBody({ item }: { item: DynamicToolCallItem }) {
	const view = toolDetailView(item);
	const failed = item.status === "failed";
	switch (view.kind) {
		case "command":
			return <CommandPanel view={view} failed={failed} />;
		case "read":
			return <ReadPanel view={view} />;
		case "edit":
			return <EditPanel view={view} failed={failed} />;
		case "write":
			return <WritePanel view={view} failed={failed} />;
		case "patch":
			return <PatchPanel diff={view.diff} />;
		case "fields":
			return <FieldsPanel view={view} failed={failed} />;
	}
}

function Panel({
	head,
	aside,
	children,
	kind,
}: {
	head: ReactNode;
	aside?: ReactNode;
	children?: ReactNode;
	kind: string;
}) {
	return (
		<div className="tool-panel" data-kind={kind}>
			<div className="tool-panel-head">
				<div className="tool-panel-title">{head}</div>
				{aside ? <div className="tool-panel-aside">{aside}</div> : null}
			</div>
			{children}
		</div>
	);
}

function PathHead({ path }: { path: string }) {
	const name = fileBasename(path);
	const folder = path.slice(0, path.length - name.length);
	return (
		<>
			<FileTypeIcon path={path} size={14} />
			<span className="tool-panel-path" title={path}>
				{folder ? <span className="tool-panel-folder">{folder}</span> : null}
				{name}
			</span>
		</>
	);
}

function ExitTag({
	exit,
	failed,
}: {
	exit: Extract<ToolDetailView, { kind: "command" }>["exit"];
	failed: boolean;
}) {
	if (failed)
		return (
			<span className="tool-panel-tag" data-tone="bad">
				Failed
			</span>
		);
	if (exit === null) return null;
	if (exit === "running")
		return <span className="tool-panel-tag">Running</span>;
	if (exit === "timeout")
		return (
			<span className="tool-panel-tag" data-tone="bad">
				Timed out
			</span>
		);
	return (
		<span className="tool-panel-tag" data-tone={exit === 0 ? "good" : "bad"}>
			exit {exit}
		</span>
	);
}

function CommandPanel({
	view,
	failed,
}: {
	view: Extract<ToolDetailView, { kind: "command" }>;
	failed: boolean;
}) {
	return (
		<Panel
			kind="command"
			head={
				<div className="tool-panel-command">
					<span className="tool-panel-prompt" aria-hidden="true">
						$
					</span>
					<ShellCommandCode command={view.command} />
				</div>
			}
			aside={<ExitTag exit={view.exit} failed={failed} />}
		>
			{view.output ? (
				<pre className="tool-panel-body tool-panel-output">{view.output}</pre>
			) : !failed && view.exit !== "running" ? (
				<p className="tool-panel-empty">No output</p>
			) : null}
			{view.note ? (
				<p className="tool-panel-note" data-tone={failed ? "bad" : undefined}>
					{view.note}
				</p>
			) : null}
		</Panel>
	);
}

/** Source lines with a line-number gutter, highlighted for the file's language. */
function NumberedCode({
	path,
	lines,
	startLine,
	sign,
}: {
	path: string;
	lines: string[];
	startLine?: number;
	sign?: "added" | "removed";
}) {
	const tokens = useHighlightedLines(
		lines.join("\n"),
		sourceLanguageFromPath(path),
	);
	return (
		<>
			{lines.map((line, index) => (
				// Lines are positional: their place in the file is their identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: positional source lines
				<div key={index} className="tool-line" data-sign={sign}>
					<span className="tool-line-number">
						{sign === "added"
							? "+"
							: sign === "removed"
								? "−"
								: (startLine ?? 1) + index}
					</span>
					<span className="tool-line-code">
						<HighlightedTokens text={line} tokens={tokens?.[index]} />
						{line ? null : " "}
					</span>
				</div>
			))}
		</>
	);
}

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

function ReadPanel({
	view,
}: {
	view: Extract<ToolDetailView, { kind: "read" }>;
}) {
	const last = view.startLine + view.lines.length - 1;
	return (
		<Panel
			kind="read"
			head={<PathHead path={view.path} />}
			aside={
				<span className="tool-panel-meta">
					{view.lines.length === 1
						? `line ${view.startLine}`
						: `lines ${view.startLine}–${last}`}
					{view.totalLines ? ` of ${view.totalLines}` : ""}
				</span>
			}
		>
			<div className="tool-panel-body tool-panel-code">
				<NumberedCode
					path={view.path}
					lines={view.lines}
					startLine={view.startLine}
				/>
			</div>
			{view.note ? <p className="tool-panel-note">{view.note}</p> : null}
		</Panel>
	);
}

const splitLines = (text: string) =>
	text === "" ? [] : text.replace(/\n$/, "").split("\n");

function EditPanel({
	view,
	failed,
}: {
	view: Extract<ToolDetailView, { kind: "edit" }>;
	failed: boolean;
}) {
	const added = view.hunks.reduce(
		(sum, hunk) => sum + splitLines(hunk.added).length,
		0,
	);
	const removed = view.hunks.reduce(
		(sum, hunk) => sum + splitLines(hunk.removed).length,
		0,
	);
	// A plain success message repeats the diff; keep failures and fuzzy matches.
	const note =
		view.note && (failed || /normaliz/i.test(view.note)) ? view.note : null;
	return (
		<Panel
			kind="edit"
			head={<PathHead path={view.path} />}
			aside={
				failed ? (
					<span className="tool-panel-tag" data-tone="bad">
						Not applied
					</span>
				) : (
					<span className="session-tool-stats">
						<span data-sign="added">+{added}</span>
						<span data-sign="removed">−{removed}</span>
					</span>
				)
			}
		>
			<div className="tool-panel-body tool-panel-code">
				{view.hunks.map((hunk, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: edits keep their order
					<div key={index} className="tool-hunk">
						<NumberedCode
							path={view.path}
							lines={splitLines(hunk.removed)}
							sign="removed"
						/>
						<NumberedCode
							path={view.path}
							lines={splitLines(hunk.added)}
							sign="added"
						/>
					</div>
				))}
			</div>
			{note ? (
				<p className="tool-panel-note" data-tone={failed ? "bad" : undefined}>
					{note}
				</p>
			) : null}
		</Panel>
	);
}

function WritePanel({
	view,
	failed,
}: {
	view: Extract<ToolDetailView, { kind: "write" }>;
	failed: boolean;
}) {
	const lines = splitLines(view.content);
	const created = view.note?.startsWith("Created");
	return (
		<Panel
			kind="write"
			head={<PathHead path={view.path} />}
			aside={
				failed ? (
					<span className="tool-panel-tag" data-tone="bad">
						Not written
					</span>
				) : (
					<span className="tool-panel-meta">
						{created ? "New file · " : ""}
						{plural(lines.length, "line")}
					</span>
				)
			}
		>
			<div className="tool-panel-body tool-panel-code">
				<NumberedCode path={view.path} lines={lines} startLine={1} />
			</div>
			{failed && view.note ? (
				<p className="tool-panel-note" data-tone="bad">
					{view.note}
				</p>
			) : null}
		</Panel>
	);
}

function PatchPanel({ diff }: { diff: string }) {
	return (
		<Panel kind="patch" head={<span className="tool-panel-meta">Patch</span>}>
			<div className="tool-panel-body tool-panel-code">
				{diff.split("\n").map((line, index) => {
					const sign = line.startsWith("+")
						? "added"
						: line.startsWith("-")
							? "removed"
							: undefined;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional patch lines
						<div key={index} className="tool-line" data-sign={sign}>
							<span className="tool-line-code">{line || " "}</span>
						</div>
					);
				})}
			</div>
		</Panel>
	);
}

function FieldsPanel({
	view,
	failed,
}: {
	view: Extract<ToolDetailView, { kind: "fields" }>;
	failed: boolean;
}) {
	if (!view.input && !view.output)
		return (
			<p className="tool-panel-empty">
				Details were not recorded for this call.
			</p>
		);
	return (
		<div className="tool-panel" data-kind="fields">
			{view.input ? (
				<div className="tool-panel-section">
					<ToolInputFields input={view.input} />
				</div>
			) : null}
			{view.output ? (
				<pre
					className="tool-panel-body tool-panel-output"
					data-tone={failed ? "bad" : undefined}
				>
					{view.output}
				</pre>
			) : null}
		</div>
	);
}

/** A run_code program, numbered and highlighted as JavaScript. */
export function ProgramSource({ program }: { program: string }) {
	return (
		<div className="tool-panel-body tool-panel-code">
			<NumberedCode
				path="program.js"
				lines={program.split("\n")}
				startLine={1}
			/>
		</div>
	);
}
