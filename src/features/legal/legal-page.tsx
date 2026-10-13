import type { ReactNode } from "react";

/** Draft legal copy: shown with a banner until counsel has reviewed it. */
export function LegalPage(props: {
	readonly title: string;
	readonly sections: readonly { heading: string; body: ReactNode }[];
}) {
	return (
		<main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-6">
			<p
				role="note"
				className="mb-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
			>
				Draft for review. This text has not been reviewed by counsel and is not
				yet in effect.
			</p>
			<h1 className="mb-6 text-2xl font-semibold">{props.title}</h1>
			{props.sections.map((section) => (
				<section key={section.heading} className="mb-6">
					<h2 className="mb-2 text-base font-semibold">{section.heading}</h2>
					<div className="text-muted-foreground">{section.body}</div>
				</section>
			))}
		</main>
	);
}
