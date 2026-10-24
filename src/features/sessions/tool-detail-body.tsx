import type { ReactNode } from "react";
import { fileBasename } from "#/domain/file-kind";
import type { McpBlock } from "#/domain/mcp-call-view";
import type { DynamicToolCallItem } from "#/domain/session-item";
import { sourceLanguageFromPath } from "#/domain/source-language";
import { type ToolDetailView, toolDetailView } from "#/domain/tool-detail-view";
import { AgentMarkdown } from "./agent-markdown";
import { FileTypeIcon } from "./file-type-icon";
import { HighlightedTokens, useHighlightedLines } from "./highlighted-code";
import { McpServerIcon } from "./mcp-server-icon";
import { ShellCommandCode } from "./shell-command-code";
import { ToolInputFields } from "./tool-cards";
import { looksLong, ShowMore, ToolFields, ToolValue } from "./tool-value";

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
		case "mcp":
			return (
				<McpPanel
					view={view}
					failed={failed}
					running={item.status === "inProgress"}
				/>
			);
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
			{view.output && !failed && /^\s*[[{]/.test(view.output) ? (
				<div className="tool-panel-section" data-part="output">
					<ShowMore long={looksLong(view.output)}>
						<ToolFields input={view.output} empty="No output" />
					</ShowMore>
				</div>
			) : view.output ? (
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

/** Roughly how much a result shows, to decide whether it starts clamped. */
function blocksText(blocks: readonly McpBlock[]) {
	return blocks
		.map((block) =>
			block.kind === "text"
				? block.text
				: block.kind === "json"
					? JSON.stringify(block.value, null, 2)
					: block.kind === "resource"
						? (block.text ?? block.uri)
						: block.kind === "image"
							? "\n".repeat(12)
							: "",
		)
		.join("\n");
}

function McpBlockView({ block, bad }: { block: McpBlock; bad: boolean }) {
	switch (block.kind) {
		case "text":
			return block.markdown && !bad ? (
				<div className="tool-mcp-markdown">
					<AgentMarkdown text={block.text} />
				</div>
			) : (
				<div className="tool-mcp-text" data-tone={bad ? "bad" : undefined}>
					{block.text}
				</div>
			);
		case "json":
			return <ToolValue value={block.value} />;
		case "image":
			return (
				<img className="tool-mcp-image" src={block.src} alt="Tool result" />
			);
		case "audio":
			// biome-ignore lint/a11y/useMediaCaption: tool output has no captions
			return <audio className="tool-mcp-audio" controls src={block.src} />;
		case "link":
			return (
				<div className="tool-mcp-link">
					{block.href ? (
						<a href={block.href} target="_blank" rel="noopener noreferrer">
							{block.label}
						</a>
					) : (
						<code>{block.label}</code>
					)}
					{block.label !== block.uri ? (
						<span className="tool-panel-meta">{block.uri}</span>
					) : null}
					{block.description ? <p>{block.description}</p> : null}
				</div>
			);
		case "resource":
			return (
				<div className="tool-mcp-resource">
					<div className="tool-mcp-link">
						{block.href ? (
							<a href={block.href} target="_blank" rel="noopener noreferrer">
								{block.uri}
							</a>
						) : (
							<code>{block.uri}</code>
						)}
						{block.mimeType ? (
							<span className="tool-panel-meta">{block.mimeType}</span>
						) : null}
					</div>
					{block.text ? (
						<div className="tool-mcp-text">{block.text}</div>
					) : null}
				</div>
			);
	}
}

/** An MCP call: the server and tool, the arguments as fields, the result as its content blocks. */
function McpPanel({
	view,
	failed,
	running,
}: {
	view: Extract<ToolDetailView, { kind: "mcp" }>;
	failed: boolean;
	running: boolean;
}) {
	const result = view.result;
	const bad = failed || result?.isError === true;
	const outputText = result ? blocksText(result.blocks) : "";
	return (
		<Panel
			kind="mcp"
			head={
				<>
					<McpServerIcon server={view.call.server} />
					<span
						className="tool-panel-path"
						title={`${view.call.server} / ${view.call.tool}`}
					>
						<span className="tool-panel-folder">{view.call.server} / </span>
						{view.call.tool}
					</span>
				</>
			}
			aside={
				bad ? (
					<span className="tool-panel-tag" data-tone="bad">
						{failed ? "Failed" : "Error"}
					</span>
				) : running ? (
					<span className="tool-panel-tag">Running</span>
				) : null
			}
		>
			<div className="tool-panel-section" data-part="input">
				<p className="tool-panel-label">Input</p>
				{view.input ? (
					<ShowMore long={looksLong(view.input)}>
						<ToolFields input={view.input} />
					</ShowMore>
				) : (
					<p className="tool-panel-meta">No arguments</p>
				)}
			</div>
			{result || !running ? (
				<div
					className="tool-panel-section"
					data-part="output"
					data-tone={bad ? "bad" : undefined}
				>
					<p className="tool-panel-label">{bad ? "Error" : "Output"}</p>
					{result?.blocks.length ? (
						<ShowMore long={looksLong(outputText)}>
							<div className="tool-mcp-blocks">
								{result.blocks.map((block, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: content blocks keep their order
									<McpBlockView key={index} block={block} bad={bad} />
								))}
							</div>
						</ShowMore>
					) : (
						<p className="tool-panel-meta">No output</p>
					)}
				</div>
			) : null}
			{result?.note ? <p className="tool-panel-note">{result.note}</p> : null}
		</Panel>
	);
}
