import { type ComponentProps, lazy, Suspense } from "react";
import type { AgentMarkdown as Renderer } from "./agent-markdown-renderer";

/**
 * The Markdown renderer (Streamdown with its parsers, Mermaid, KaTeX and
 * code highlighting, about 0.5 MB) is its own chunk, so it stays out of the
 * home route's first load. It loads once the page is idle; until then a
 * reply shows as plain text.
 */
const loadRenderer = () => import("./agent-markdown-renderer");
const LazyRenderer = lazy(() =>
	loadRenderer().then((module) => ({ default: module.AgentMarkdown })),
);

if (typeof window !== "undefined") {
	const idle =
		window.requestIdleCallback ??
		((run: () => void) => window.setTimeout(run, 1_000));
	idle(() => {
		void loadRenderer().catch(() => {});
	});
}

export function AgentMarkdown(props: ComponentProps<typeof Renderer>) {
	return (
		<Suspense fallback={<PlainMarkdown text={props.text} />}>
			<LazyRenderer {...props} />
		</Suspense>
	);
}

function PlainMarkdown({ text }: { text: string }) {
	return <div className="whitespace-pre-wrap break-words">{text}</div>;
}
