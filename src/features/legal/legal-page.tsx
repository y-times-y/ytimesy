import { Link } from "@tanstack/react-router";
import "streamdown/styles.css";
import { type Components, Streamdown } from "streamdown";
import { LEGAL_DOCUMENTS_IN_EFFECT } from "#/content/legal/versions";

/**
 * In-app paths of the legal documents, keyed by how the drafts link them
 * (Streamdown resolves "./privacy.md" to "/privacy.md").
 */
const LEGAL_LINKS: Record<string, "/terms" | "/privacy" | "/training"> = {
	"/terms.md": "/terms",
	"/privacy.md": "/privacy",
	"/training-opt-in.md": "/training",
	"/terms": "/terms",
	"/privacy": "/privacy",
	"/training": "/training",
};

/**
 * Drops the internal part of a draft before it is shown: everything from the
 * exact heading line `cutAt` onward. `[OWNER/COUNSEL: ...]` placeholders stay
 * visible on purpose until the owner resolves them in the source file.
 */
export function publicLegalMarkdown(markdown: string, cutAt?: string) {
	if (!cutAt) return markdown;
	const index = markdown.indexOf(`\n${cutAt}\n`);
	return index === -1 ? markdown : `${markdown.slice(0, index).trimEnd()}\n`;
}

const components: Components = {
	a: ({ href, children }) => {
		const internal = href ? LEGAL_LINKS[href] : undefined;
		if (internal)
			return (
				<Link to={internal} className="underline underline-offset-4">
					{children}
				</Link>
			);
		if (href && /^(https:\/\/|mailto:)/.test(href))
			return (
				<a
					href={href}
					target="_blank"
					rel="noopener noreferrer"
					className="underline underline-offset-4"
				>
					{children}
				</a>
			);
		// Links to internal working files are not published.
		return <span>{children}</span>;
	},
};

/** A legal document rendered from its markdown source in src/content/legal. */
export function LegalPage(props: {
	readonly markdown: string;
	readonly version: string;
	/** Defaults to LEGAL_DOCUMENTS_IN_EFFECT. */
	readonly inEffect?: boolean;
}) {
	const inEffect = props.inEffect ?? LEGAL_DOCUMENTS_IN_EFFECT;
	return (
		<main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-6">
			{!inEffect && (
				<p
					role="note"
					className="mb-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
				>
					Draft — not yet in effect. This text is under legal review and will
					change before it applies.
				</p>
			)}
			<article>
				<Streamdown
					mode="static"
					parseIncompleteMarkdown={false}
					components={components}
				>
					{props.markdown}
				</Streamdown>
			</article>
			<p className="mt-10 text-xs text-muted-foreground">
				Version {props.version}
			</p>
		</main>
	);
}
