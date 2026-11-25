import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { setupCard } from "#/domain/setup-card";
import { SetupCard } from "./setup-card";

const noop = () => undefined;

it("building: spinner, progress at Building, no actions, a calm status", () => {
	const html = renderToStaticMarkup(
		<SetupCard model={setupCard({ status: "installing" })} details={<i />} />,
	);
	expect(html).toContain('role="status"');
	expect(html).toContain("workspace-status-spin");
	expect(html).toMatch(
		/data-current="true"[^>]*aria-current="step"[^>]*>Building/,
	);
	expect(html).toContain("Installing dependencies");
	expect(html).not.toContain("setup-card-actions");
});

it("failed: the real reason, a primary action, quieter ones, folded details", () => {
	const html = renderToStaticMarkup(
		<SetupCard
			model={setupCard({
				status: "failed",
				errorMessage: "Repository not found.",
				build: {
					status: "failed",
					rebuild: false,
					errorMessage: "Repository not found.",
					failure: null,
				},
			})}
			primary={{ label: "Retry", onClick: noop }}
			secondary={[{ label: "Send anyway", onClick: noop }]}
			details={<pre>log</pre>}
		/>,
	);
	expect(html).toContain("Repository not found.");
	expect(html).toContain('data-tone="failure"');
	expect(html).toContain('role="alert"');
	expect(html).toMatch(/setup-card-primary[^>]*>Retry/);
	expect(html).toMatch(/setup-card-secondary[^>]*>Send anyway/);
	expect(html).toContain("<details");
	expect(html).toContain("Details and logs");
});

it("needs GitHub: the neutral needs-you tone, its step in place, no spinner", () => {
	const html = renderToStaticMarkup(
		<SetupCard
			model={setupCard({
				status: "failed",
				errorMessage: "Connect GitHub to set up this project.",
			})}
			primary={{ label: "Retry", onClick: noop }}
		>
			<div>GITHUB STEP</div>
		</SetupCard>,
	);
	expect(html).toContain('data-tone="needs-you"');
	expect(html).toContain("GITHUB STEP");
	expect(html).not.toContain("workspace-status-spin");
});

it("ready shows all progress done up to Ready", () => {
	const html = renderToStaticMarkup(
		<SetupCard model={setupCard({ status: "ready" })} />,
	);
	expect(html).toContain('data-state="ready"');
	expect(html).toMatch(
		/data-current="true"[^>]*aria-current="step"[^>]*>Ready/,
	);
});
