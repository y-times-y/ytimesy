import type { HighlightResult } from "@streamdown/code";
import { useContext, useEffect, useRef, useState } from "react";
import type { FileChangeEntry } from "#/domain/session-item";
import { useHydrating } from "../app/first-paint";
import { AgentMentionContext } from "./agent-chip";
import { AgentMarkdown } from "./agent-markdown";

/**
 * A reply's Markdown segment. While the page hydrates, a settled one takes
 * over the server's HTML as it is instead of parsing its Markdown again
 * (the Markdown renderer is then not needed to hydrate it); its file
 * mentions open through one delegated click, and its code blocks get their
 * colours once the page is idle. Streaming replies, replies mounted later,
 * and replies whose agent names are drawn as chips render with the
 * Markdown renderer.
 */
export function ReplyMarkdown({
	segmentKey,
	text,
	streaming,
	fileChanges,
	onOpenFile,
}: {
	/** Unique on the page: the reply's id and the segment's index. */
	segmentKey: string;
	text: string;
	streaming: boolean;
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	const mentions = useContext(AgentMentionContext);
	const adoptable = !streaming && settledMarkdownAdoptable(text, mentions);
	const hydrating = useHydrating();
	const [adopted] = useState(() =>
		adoptable && hydrating && typeof document !== "undefined"
			? { text, html: serverSettledHtml(segmentKey) }
			: null,
	);
	const ref = useRef<HTMLDivElement>(null);
	const keep = adopted?.html != null && adopted.text === text && adoptable;
	useEffect(() => {
		if (keep && ref.current) return colourCodeBlocksWhenIdle(ref.current);
	}, [keep]);
	if (keep)
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: delegates to the file buttons inside, which stay keyboard-reachable buttons.
			<div
				ref={ref}
				data-md-key={segmentKey}
				data-md-settled=""
				style={{ display: "contents" }}
				suppressHydrationWarning
				// biome-ignore lint/security/noDangerouslySetInnerHtml: the server's own render of this reply, read back from the page.
				dangerouslySetInnerHTML={{ __html: adopted.html as string }}
				onClick={(event) => {
					const button =
						event.target instanceof Element
							? event.target.closest<HTMLElement>(
									"button.session-file-open[data-path]",
								)
							: null;
					if (button?.dataset.path) onOpenFile?.(button.dataset.path);
				}}
			/>
		);
	return (
		<div
			data-md-key={segmentKey}
			data-md-settled={adoptable ? "" : undefined}
			style={{ display: "contents" }}
		>
			<AgentMarkdown
				text={text}
				streaming={streaming}
				fileChanges={fileChanges}
				onOpenFile={onOpenFile}
			/>
		</div>
	);
}

/**
 * The server's HTML of a settled reply can stand as it is: nothing in it
 * needs React (agent chips do; Mermaid diagrams draw in the browser).
 */
export function settledMarkdownAdoptable(
	text: string,
	mentions: { readonly agents?: readonly unknown[] } | null,
) {
	return !mentions?.agents?.length && !/```\s*mermaid/i.test(text);
}

function serverSettledHtml(segmentKey: string): string | null {
	const element = document.querySelector(
		`[data-md-key="${CSS.escape(segmentKey)}"][data-md-settled]`,
	);
	return element ? element.innerHTML : null;
}

/** Colours the adopted code blocks one at a time while the page is idle. */
function colourCodeBlocksWhenIdle(container: HTMLElement): () => void {
	let cancelled = false;
	const blocks = [
		...container.querySelectorAll<HTMLElement>(
			'[data-streamdown="code-block"][data-language]',
		),
	];
	if (!blocks.length) return () => {};
	const idle =
		window.requestIdleCallback ??
		((run: () => void) => window.setTimeout(run, 50));
	void import("./code-highlighter").then(({ codeHighlighter }) => {
		const next = () => {
			const block = blocks.shift();
			if (cancelled || !block) return;
			colourCodeBlock(block, codeHighlighter);
			idle(next);
		};
		idle(next);
	});
	return () => {
		cancelled = true;
	};
}

type Highlighter = typeof import("./code-highlighter")["codeHighlighter"];

/**
 * Paints Shiki's colours into a server-rendered (uncoloured) Streamdown
 * code block, as Streamdown's highlighted body would draw them: the same
 * text in the same lines, so nothing moves.
 */
function colourCodeBlock(block: HTMLElement, highlighter: Highlighter) {
	const language = block.dataset.language ?? "";
	const code = block.querySelector("pre > code");
	if (!code || !language || language === "text") return;
	if (!highlighter.supportsLanguage(language as never)) return;
	const lines = [...code.children] as HTMLElement[];
	const source = lines
		.map((line) => (line.textContent === "\n" ? "" : (line.textContent ?? "")))
		.join("\n");
	const paint = (result: HighlightResult) => {
		if (!block.isConnected || result.tokens.length !== lines.length) return;
		const pre = code.parentElement;
		if (pre) applyRootStyle(pre, result);
		result.tokens.forEach((tokens, index) => {
			const line = lines[index];
			const template = line?.firstElementChild;
			if (!line || !template || tokens.length === 0) return;
			if (tokens.length === 1 && tokens[0]?.content === "") return;
			line.replaceChildren(
				...tokens.map((token) => {
					const span = document.createElement("span");
					span.className = template.className;
					if (token.color) span.style.setProperty("--sdm-c", token.color);
					if (token.bgColor) span.style.setProperty("--sdm-tbg", token.bgColor);
					for (const [name, value] of Object.entries(token.htmlStyle ?? {}))
						span.style.setProperty(
							name === "color"
								? "--sdm-c"
								: name === "background-color"
									? "--sdm-tbg"
									: name,
							String(value),
						);
					for (const [name, value] of Object.entries(token.htmlAttrs ?? {}))
						span.setAttribute(name, String(value));
					span.textContent = token.content;
					return span;
				}),
			);
		});
	};
	const ready = highlighter.highlight(
		{
			code: source,
			language: language as never,
			themes: highlighter.getThemes(),
		},
		paint,
	);
	if (ready) paint(ready);
}

/** The block's background and text colours, as Streamdown sets them on <pre>. */
function applyRootStyle(pre: HTMLElement, result: HighlightResult) {
	if (result.bg) pre.style.setProperty("--sdm-bg", result.bg);
	if (result.fg) pre.style.setProperty("--sdm-fg", result.fg);
	for (const declaration of (result.rootStyle || "").split(";")) {
		const colon = declaration.indexOf(":");
		if (colon <= 0) continue;
		const name = declaration.slice(0, colon).trim();
		const value = declaration.slice(colon + 1).trim();
		if (name && value) pre.style.setProperty(name, value);
	}
}
