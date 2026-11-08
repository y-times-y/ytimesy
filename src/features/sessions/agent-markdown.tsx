import { type ComponentProps, Suspense, use } from "react";
import { readableModelCitations } from "#/domain/model-citation";
import type { AgentMarkdown as Renderer } from "./agent-markdown-renderer";

type RendererModule = typeof import("./agent-markdown-renderer");

let rendererLoad: Promise<RendererModule | null> | undefined;

/**
 * The Markdown renderer (Streamdown with its parsers, Mermaid, KaTeX and
 * code highlighting, about 0.5 MB) is its own chunk, so it stays out of the
 * home route's first load. Loaded once; null if the chunk failed to load.
 * Once loaded, React's `use` reads it without suspending: the promise
 * carries its value the way React marks the promises it tracks.
 */
export function markdownRenderer(): Promise<RendererModule | null> {
	if (!rendererLoad) {
		const load = import("./agent-markdown-renderer").catch(() => null);
		Object.assign(load, { status: "pending" });
		void load.then((module) =>
			Object.assign(load, { status: "fulfilled", value: module }),
		);
		rendererLoad = load;
	}
	return rendererLoad;
}

/**
 * Server-rendered Markdown that needs the renderer to hydrate. Settled
 * replies take over their server HTML instead (settled-markdown.tsx).
 */
export const LIVE_MARKDOWN = ".session-markdown:not([data-md-settled] *)";

// The signed-in app shows chats: the renderer loads at once. Elsewhere (the
// landing page) it loads once the page is idle.
if (typeof window !== "undefined") {
	if (document.querySelector(".workspace-shell, .session-markdown"))
		void markdownRenderer();
	else
		(window.requestIdleCallback ?? ((run) => window.setTimeout(run, 1_000)))(
			() => void markdownRenderer(),
		);
}

/**
 * Markdown, rendered on the server and in the browser alike. A page with
 * server-rendered Markdown hydrates once the renderer has loaded
 * (readyToHydrate), so a reply keeps its server structure. A later mount
 * shows plain text for the moment the renderer may still be loading.
 */
export function AgentMarkdown(props: ComponentProps<typeof Renderer>) {
	return (
		<Suspense fallback={<PlainMarkdown text={props.text} />}>
			<LoadedMarkdown {...props} />
		</Suspense>
	);
}

function LoadedMarkdown(props: ComponentProps<typeof Renderer>) {
	const renderer = use(markdownRenderer());
	if (!renderer) return <PlainMarkdown text={props.text} />;
	return <renderer.AgentMarkdown {...props} />;
}

function PlainMarkdown({ text }: { text: string }) {
	return (
		<div className="whitespace-pre-wrap break-words">
			{readableModelCitations(text)}
		</div>
	);
}
